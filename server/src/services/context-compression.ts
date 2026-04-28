/**
 * Context Compression Service
 *
 * Reduces token consumption by compressing context before passing it to adapters.
 * Implements four mechanisms:
 * 1. Context summary algorithm - summarizes long text fields
 * 2. Time decay - prioritizes recent context elements
 * 3. Relevance scoring - scores context elements by relevance to current task
 * 4. Context caching - caches compressed context to avoid re-computation
 */

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompressibleComment {
  id: string;
  body: string;
  createdAt: string | Date;
  author?: {
    type?: string;
    id?: string;
  } | null;
  bodyTruncated?: boolean;
}

export interface CompressibleContext {
  comments: CompressibleComment[];
  taskDescription?: string | null;
  continuationSummaryBody?: string | null;
  sessionHandoffMarkdown?: string | null;
  wakeReason?: string | null;
  issueTitle?: string | null;
  issueStatus?: string | null;
}

export interface CompressionOptions {
  /** Maximum total characters for all comment bodies combined */
  maxCommentBodyChars?: number;
  /** Maximum characters for task description */
  maxDescriptionChars?: number;
  /** Maximum characters for continuation summary */
  maxContinuationSummaryChars?: number;
  /** Maximum characters for session handoff */
  maxHandoffChars?: number;
  /** Enable time decay scoring for comments */
  enableTimeDecay?: boolean;
  /** Enable relevance scoring for comments */
  enableRelevanceScoring?: boolean;
  /** Enable context caching */
  enableCaching?: boolean;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Half-life for time decay in hours (default: 24) */
  decayHalfLifeHours?: number;
}

export interface CompressionResult {
  comments: CompressibleComment[];
  taskDescription: string | null;
  continuationSummaryBody: string | null;
  sessionHandoffMarkdown: string | null;
  stats: {
    originalCommentChars: number;
    compressedCommentChars: number;
    originalDescriptionChars: number;
    compressedDescriptionChars: number;
    originalContinuationChars: number;
    compressedContinuationChars: number;
    commentsDropped: number;
    cacheHit: boolean;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_COMMENT_BODY_CHARS = 8_000;
const DEFAULT_MAX_DESCRIPTION_CHARS = 4_000;
const DEFAULT_MAX_CONTINUATION_SUMMARY_CHARS = 4_000;
const DEFAULT_MAX_HANDOFF_CHARS = 1_500;
const DEFAULT_DECAY_HALF_LIFE_HOURS = 24;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Relevance keywords that boost a comment's score
const HIGH_RELEVANCE_KEYWORDS = [
  "blocker", "blocked", "urgent", "critical", "bug", "error", "fail",
  "deploy", "release", "merge", "conflict", "security", "vulnerability",
  "review", "approve", "reject", "changes requested", "lgtm", "ship it",
  "assign", "reassign", "unassign", "priority", "deadline",
];

const LOW_RELEVANCE_PATTERNS = [
  /^(ok|okay|thanks|thank you|got it|ack|acknowledged|noted)\.?$/i,
  /^(lgtm|👍|✅|🎉)\s*$/i,
  /^ping\b/i,
];

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: CompressionResult;
  expiresAt: number;
}

const contextCache = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 256;

function computeCacheKey(context: CompressibleContext, options: CompressionOptions): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    commentIds: context.comments.map((c) => c.id),
    commentBodies: context.comments.map((c) => c.body),
    description: context.taskDescription,
    continuation: context.continuationSummaryBody,
    handoff: context.sessionHandoffMarkdown,
    opts: {
      maxCommentBodyChars: options.maxCommentBodyChars,
      maxDescriptionChars: options.maxDescriptionChars,
      maxContinuationSummaryChars: options.maxContinuationSummaryChars,
      maxHandoffChars: options.maxHandoffChars,
      enableTimeDecay: options.enableTimeDecay,
      enableRelevanceScoring: options.enableRelevanceScoring,
      decayHalfLifeHours: options.decayHalfLifeHours,
    },
  }));
  return hash.digest("hex");
}

function getCached(key: string): CompressionResult | null {
  const entry = contextCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    contextCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: CompressionResult, ttlMs: number): void {
  // Evict oldest entries if cache is full
  if (contextCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey) contextCache.delete(oldestKey);
  }
  contextCache.set(key, {
    result,
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearContextCache(): void {
  contextCache.clear();
}

// ─── Time Decay ──────────────────────────────────────────────────────────────

/**
 * Computes a time decay score for a comment based on its age.
 * Uses exponential decay with configurable half-life.
 * Returns a score between 0 and 1, where 1 is most recent.
 */
function computeTimeDecayScore(
  createdAt: string | Date,
  now: number,
  halfLifeHours: number,
): number {
  const timestamp = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  const ageHours = Math.max(0, (now - timestamp) / (1000 * 60 * 60));
  // Exponential decay: score = 2^(-age / halfLife)
  return Math.pow(2, -ageHours / halfLifeHours);
}

// ─── Relevance Scoring ───────────────────────────────────────────────────────

/**
 * Computes a relevance score for a comment based on its content and context.
 * Returns a score between 0 and 1.
 */
function computeRelevanceScore(
  comment: CompressibleComment,
  taskContext: { issueTitle?: string | null; issueStatus?: string | null },
): number {
  let score = 0.5; // baseline
  const body = comment.body.toLowerCase();

  // Boost for high-relevance keywords
  for (const keyword of HIGH_RELEVANCE_KEYWORDS) {
    if (body.includes(keyword)) {
      score += 0.15;
    }
  }

  // Penalty for low-relevance patterns (acknowledgments, pings, etc.)
  for (const pattern of LOW_RELEVANCE_PATTERNS) {
    if (pattern.test(comment.body.trim())) {
      score -= 0.3;
    }
  }

  // Boost for user comments over agent comments
  if (comment.author?.type === "user") {
    score += 0.1;
  }

  // Boost for longer comments (more content = more likely relevant)
  if (comment.body.length > 500) {
    score += 0.1;
  } else if (comment.body.length < 50) {
    score -= 0.1;
  }

  // Boost if comment mentions the issue title keywords
  if (taskContext.issueTitle) {
    const titleWords = taskContext.issueTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of titleWords) {
      if (body.includes(word)) {
        score += 0.05;
      }
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ─── Text Summarization ─────────────────────────────────────────────────────

/**
 * Truncates text to maxChars, preserving sentence boundaries when possible.
 */
function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const ellipsis = "...";
  const targetLen = maxChars - ellipsis.length;
  if (targetLen <= 0) return text.slice(0, maxChars);

  const truncated = text.slice(0, targetLen);
  // Try to break at a sentence boundary
  const lastPeriod = truncated.lastIndexOf(". ");
  const lastNewline = truncated.lastIndexOf("\n");
  const breakPoint = Math.max(lastPeriod, lastNewline);

  if (breakPoint > targetLen * 0.6) {
    return truncated.slice(0, breakPoint + 1).trimEnd();
  }
  return `${truncated.trimEnd()}${ellipsis}`;
}

/**
 * Summarizes a long issue description by extracting key sections.
 * Preserves Objective, Acceptance Criteria, and key structural elements.
 */
function summarizeDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) return description;

  // Try to extract key sections
  const sections: string[] = [];
  const sectionPatterns = [
    /^#{1,3}\s+objective\b/im,
    /^#{1,3}\s+acceptance\s+criteria\b/im,
    /^#{1,3}\s+summary\b/im,
    /^#{1,3}\s+goal\b/im,
    /^#{1,3}\s+requirements?\b/im,
  ];

  for (const pattern of sectionPatterns) {
    const match = pattern.exec(description);
    if (match) {
      const sectionStart = match.index;
      const nextHeading = /^#{1,3}\s+/m.exec(description.slice(match.index + match[0].length));
      const sectionEnd = nextHeading
        ? sectionStart + match[0].length + nextHeading.index
        : description.length;
      const section = description.slice(sectionStart, sectionEnd).trim();
      if (section.length > 0) {
        sections.push(section);
      }
    }
  }

  if (sections.length > 0) {
    const combined = sections.join("\n\n");
    if (combined.length <= maxChars) return combined;
    return smartTruncate(combined, maxChars);
  }

  // Fallback: take the first maxChars with smart truncation
  return smartTruncate(description, maxChars);
}

// ─── Main Compression Function ──────────────────────────────────────────────

/**
 * Compresses a context object to reduce token consumption.
 * Applies time decay, relevance scoring, and smart truncation.
 */
export function compressContext(
  context: CompressibleContext,
  options: CompressionOptions = {},
): CompressionResult {
  const {
    maxCommentBodyChars = DEFAULT_MAX_COMMENT_BODY_CHARS,
    maxDescriptionChars = DEFAULT_MAX_DESCRIPTION_CHARS,
    maxContinuationSummaryChars = DEFAULT_MAX_CONTINUATION_SUMMARY_CHARS,
    maxHandoffChars = DEFAULT_MAX_HANDOFF_CHARS,
    enableTimeDecay = true,
    enableRelevanceScoring = true,
    enableCaching = true,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    decayHalfLifeHours = DEFAULT_DECAY_HALF_LIFE_HOURS,
  } = options;

  // Check cache
  if (enableCaching) {
    const cacheKey = computeCacheKey(context, options);
    const cached = getCached(cacheKey);
    if (cached) {
      return { ...cached, stats: { ...cached.stats, cacheHit: true } };
    }
  }

  const now = Date.now();
  const originalCommentChars = context.comments.reduce((sum, c) => sum + c.body.length, 0);
  const originalDescriptionChars = context.taskDescription?.length ?? 0;
  const originalContinuationChars = context.continuationSummaryBody?.length ?? 0;

  // ── Step 1: Score and sort comments ──
  let scoredComments = context.comments.map((comment) => {
    let compositeScore = 1.0;

    if (enableTimeDecay) {
      const timeScore = computeTimeDecayScore(comment.createdAt, now, decayHalfLifeHours);
      compositeScore *= timeScore;
    }

    if (enableRelevanceScoring) {
      const relevanceScore = computeRelevanceScore(comment, {
        issueTitle: context.issueTitle,
        issueStatus: context.issueStatus,
      });
      compositeScore *= relevanceScore;
    }

    return { comment, score: compositeScore };
  });

  // Sort by score descending (highest priority first)
  scoredComments.sort((a, b) => b.score - a.score);

  // ── Step 2: Select comments within budget ──
  const selectedComments: CompressibleComment[] = [];
  let remainingChars = maxCommentBodyChars;
  let commentsDropped = 0;

  for (const { comment } of scoredComments) {
    if (remainingChars <= 0) {
      commentsDropped++;
      continue;
    }

    const allowedChars = Math.min(comment.body.length, remainingChars);
    if (allowedChars <= 0) {
      commentsDropped++;
      continue;
    }

    const compressedBody = comment.body.length > allowedChars
      ? smartTruncate(comment.body, allowedChars)
      : comment.body;

    selectedComments.push({
      ...comment,
      body: compressedBody,
      bodyTruncated: compressedBody.length < comment.body.length || comment.bodyTruncated,
    });

    remainingChars -= compressedBody.length;
  }

  // Restore chronological order for the selected comments
  selectedComments.sort((a, b) => {
    const timeA = typeof a.createdAt === "string" ? new Date(a.createdAt).getTime() : a.createdAt.getTime();
    const timeB = typeof b.createdAt === "string" ? new Date(b.createdAt).getTime() : b.createdAt.getTime();
    return timeA - timeB;
  });

  // ── Step 3: Compress task description ──
  const compressedDescription = context.taskDescription
    ? summarizeDescription(context.taskDescription, maxDescriptionChars)
    : null;

  // ── Step 4: Compress continuation summary ──
  const compressedContinuation = context.continuationSummaryBody
    ? smartTruncate(context.continuationSummaryBody, maxContinuationSummaryChars)
    : null;

  // ── Step 5: Compress session handoff ──
  const compressedHandoff = context.sessionHandoffMarkdown
    ? smartTruncate(context.sessionHandoffMarkdown, maxHandoffChars)
    : null;

  const compressedCommentChars = selectedComments.reduce((sum, c) => sum + c.body.length, 0);

  const result: CompressionResult = {
    comments: selectedComments,
    taskDescription: compressedDescription,
    continuationSummaryBody: compressedContinuation,
    sessionHandoffMarkdown: compressedHandoff,
    stats: {
      originalCommentChars,
      compressedCommentChars,
      originalDescriptionChars,
      compressedDescriptionChars: compressedDescription?.length ?? 0,
      originalContinuationChars,
      compressedContinuationChars: compressedContinuation?.length ?? 0,
      commentsDropped,
      cacheHit: false,
    },
  };

  // Cache the result
  if (enableCaching) {
    const cacheKey = computeCacheKey(context, options);
    setCache(cacheKey, result, cacheTtlMs);
  }

  return result;
}

// ─── Integration Helpers ─────────────────────────────────────────────────────

/**
 * Compresses a paperclipWake payload's comments in-place.
 * Returns the compressed comments array and truncation stats.
 */
export function compressWakeComments(
  comments: CompressibleComment[],
  options: Pick<CompressionOptions, "maxCommentBodyChars" | "enableTimeDecay" | "enableRelevanceScoring" | "decayHalfLifeHours"> & {
    issueTitle?: string | null;
    issueStatus?: string | null;
  },
): { comments: CompressibleComment[]; dropped: number; savedChars: number } {
  const result = compressContext(
    {
      comments,
      issueTitle: options.issueTitle,
      issueStatus: options.issueStatus,
    },
    {
      maxCommentBodyChars: options.maxCommentBodyChars,
      enableTimeDecay: options.enableTimeDecay,
      enableRelevanceScoring: options.enableRelevanceScoring,
      decayHalfLifeHours: options.decayHalfLifeHours,
      enableCaching: false, // Don't cache partial compressions
    },
  );

  return {
    comments: result.comments,
    dropped: result.stats.commentsDropped,
    savedChars: result.stats.originalCommentChars - result.stats.compressedCommentChars,
  };
}

/**
 * Compresses a task description string.
 */
export function compressTaskDescription(
  description: string,
  maxChars: number = DEFAULT_MAX_DESCRIPTION_CHARS,
): string {
  return summarizeDescription(description, maxChars);
}

/**
 * Returns compression statistics for logging/telemetry.
 */
export function getCompressionStats(result: CompressionResult): {
  totalOriginalChars: number;
  totalCompressedChars: number;
  compressionRatio: number;
  percentSaved: number;
} {
  const totalOriginal =
    result.stats.originalCommentChars +
    result.stats.originalDescriptionChars +
    result.stats.originalContinuationChars;
  const totalCompressed =
    result.stats.compressedCommentChars +
    result.stats.compressedDescriptionChars +
    result.stats.compressedContinuationChars;
  const compressionRatio = totalOriginal > 0 ? totalCompressed / totalOriginal : 1;
  const percentSaved = Math.round((1 - compressionRatio) * 100);

  return { totalOriginalChars: totalOriginal, totalCompressedChars: totalCompressed, compressionRatio, percentSaved };
}
