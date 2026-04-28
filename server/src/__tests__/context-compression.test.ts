import { describe, expect, it, beforeEach } from "vitest";
import {
  compressContext,
  compressTaskDescription,
  compressWakeComments,
  getCompressionStats,
  clearContextCache,
  type CompressibleComment,
  type CompressibleContext,
} from "../services/context-compression.js";

function makeComment(overrides: Partial<CompressibleComment> = {}): CompressibleComment {
  return {
    id: `comment-${Math.random().toString(36).slice(2, 8)}`,
    body: "This is a test comment with some content.",
    createdAt: new Date().toISOString(),
    author: { type: "user", id: "user-1" },
    ...overrides,
  };
}

describe("compressContext", () => {
  beforeEach(() => {
    clearContextCache();
  });

  it("returns empty result when no context provided", () => {
    const result = compressContext({
      comments: [],
    });
    expect(result.comments).toEqual([]);
    expect(result.taskDescription).toBeNull();
    expect(result.continuationSummaryBody).toBeNull();
    expect(result.sessionHandoffMarkdown).toBeNull();
  });

  it("preserves short comments within budget", () => {
    const comments = [
      makeComment({ body: "short comment 1" }),
      makeComment({ body: "short comment 2" }),
    ];
    const result = compressContext({ comments });
    expect(result.comments).toHaveLength(2);
    expect(result.stats.compressedCommentChars).toBe(
      "short comment 1".length + "short comment 2".length,
    );
  });

  it("truncates long comments to fit budget", () => {
    const longBody = "x".repeat(10_000);
    const comments = [makeComment({ body: longBody })];
    const result = compressContext({ comments }, { maxCommentBodyChars: 1_000 });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body.length).toBeLessThanOrEqual(1_000);
    expect(result.comments[0].bodyTruncated).toBe(true);
  });

  it("drops low-scoring comments when over budget", () => {
    // Create many comments that exceed the budget
    const comments: CompressibleComment[] = [];
    for (let i = 0; i < 20; i++) {
      comments.push(makeComment({ body: "A".repeat(500) }));
    }
    const result = compressContext(
      { comments },
      { maxCommentBodyChars: 2_000, enableTimeDecay: false, enableRelevanceScoring: false },
    );
    // All comments have the same score, so the first ones by score order are kept
    expect(result.comments.length).toBeLessThan(20);
    expect(result.stats.commentsDropped).toBeGreaterThan(0);
  });

  it("applies time decay to prioritize recent comments", () => {
    const now = new Date();
    const recentComment = makeComment({
      id: "recent",
      body: "Recent comment",
      createdAt: now.toISOString(),
    });
    const oldComment = makeComment({
      id: "old",
      body: "Old comment",
      createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
    });

    // With a very tight budget that only fits one comment
    const result = compressContext(
      { comments: [oldComment, recentComment] },
      {
        maxCommentBodyChars: 20,
        enableTimeDecay: true,
        enableRelevanceScoring: false,
        decayHalfLifeHours: 24,
      },
    );

    // The recent comment should be prioritized
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].id).toBe("recent");
  });

  it("applies relevance scoring to prioritize important comments", () => {
    const blockerComment = makeComment({
      id: "blocker",
      body: "This is a critical blocker that needs attention",
    });
    const ackComment = makeComment({
      id: "ack",
      body: "ok",
    });

    const result = compressContext(
      { comments: [ackComment, blockerComment] },
      {
        maxCommentBodyChars: 50,
        enableTimeDecay: false,
        enableRelevanceScoring: true,
      },
    );

    // The blocker comment should be prioritized over the ack
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].id).toBe("blocker");
  });

  it("compresses task description", () => {
    const longDescription = "x".repeat(10_000);
    const result = compressContext(
      { comments: [], taskDescription: longDescription },
      { maxDescriptionChars: 1_000 },
    );
    expect(result.taskDescription!.length).toBeLessThanOrEqual(1_000);
    expect(result.stats.compressedDescriptionChars).toBeLessThan(10_000);
  });

  it("preserves key sections in task description", () => {
    const description = `# Task Title

Some preamble text that is not as important.

## Objective

Build the context compression mechanism.

## Acceptance Criteria

1. Implement time decay
2. Implement relevance scoring
3. Add caching

## Additional Notes

Some extra notes that are less important.`;

    const result = compressContext(
      { comments: [], taskDescription: description },
      { maxDescriptionChars: 300 },
    );

    // Should preserve Objective and Acceptance Criteria sections
    expect(result.taskDescription).toContain("Objective");
    expect(result.taskDescription).toContain("Acceptance Criteria");
  });

  it("compresses continuation summary", () => {
    const longSummary = "x".repeat(10_000);
    const result = compressContext(
      { comments: [], continuationSummaryBody: longSummary },
      { maxContinuationSummaryChars: 2_000 },
    );
    expect(result.continuationSummaryBody!.length).toBeLessThanOrEqual(2_000);
  });

  it("compresses session handoff markdown", () => {
    const longHandoff = "x".repeat(5_000);
    const result = compressContext(
      { comments: [], sessionHandoffMarkdown: longHandoff },
      { maxHandoffChars: 1_000 },
    );
    expect(result.sessionHandoffMarkdown!.length).toBeLessThanOrEqual(1_000);
  });

  it("returns accurate compression stats", () => {
    const comments = [makeComment({ body: "x".repeat(1_000) })];
    const result = compressContext(
      { comments, taskDescription: "y".repeat(5_000) },
      { maxCommentBodyChars: 500, maxDescriptionChars: 1_000 },
    );
    const stats = getCompressionStats(result);
    expect(stats.totalOriginalChars).toBe(6_000);
    expect(stats.totalCompressedChars).toBeLessThan(6_000);
    expect(stats.percentSaved).toBeGreaterThan(0);
    expect(stats.compressionRatio).toBeLessThan(1);
  });

  it("caches results when caching is enabled", () => {
    const comments = [makeComment({ body: "test" })];
    const ctx: CompressibleContext = { comments };

    const result1 = compressContext(ctx, { enableCaching: true });
    expect(result1.stats.cacheHit).toBe(false);

    const result2 = compressContext(ctx, { enableCaching: true });
    expect(result2.stats.cacheHit).toBe(true);
  });

  it("does not cache when caching is disabled", () => {
    const comments = [makeComment({ body: "test" })];
    const ctx: CompressibleContext = { comments };

    const result1 = compressContext(ctx, { enableCaching: false });
    expect(result1.stats.cacheHit).toBe(false);

    const result2 = compressContext(ctx, { enableCaching: false });
    expect(result2.stats.cacheHit).toBe(false);
  });

  it("maintains chronological order after scoring", () => {
    const now = new Date();
    const comments = [
      makeComment({ id: "c1", createdAt: new Date(now.getTime() - 3000).toISOString() }),
      makeComment({ id: "c2", createdAt: new Date(now.getTime() - 2000).toISOString() }),
      makeComment({ id: "c3", createdAt: new Date(now.getTime() - 1000).toISOString() }),
    ];

    const result = compressContext(comments.length ? { comments } : { comments: [] });

    // Comments should be in chronological order
    for (let i = 1; i < result.comments.length; i++) {
      const prev = new Date(result.comments[i - 1].createdAt).getTime();
      const curr = new Date(result.comments[i].createdAt).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe("compressTaskDescription", () => {
  it("returns short descriptions unchanged", () => {
    const desc = "Short description";
    expect(compressTaskDescription(desc, 1_000)).toBe(desc);
  });

  it("truncates long descriptions preserving sentences", () => {
    const desc = "First sentence. Second sentence. Third sentence that is very long and continues for a while.";
    const result = compressTaskDescription(desc, 40);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it("preserves key sections when present", () => {
    const desc = `# Title

## Objective

Build something great.

## Details

Lots of details here that are less important and should be truncated when space is limited.`;

    const result = compressTaskDescription(desc, 100);
    expect(result).toContain("Objective");
  });
});

describe("compressWakeComments", () => {
  it("compresses and returns dropped count", () => {
    const comments = [
      makeComment({ body: "A".repeat(1_000) }),
      makeComment({ body: "B".repeat(1_000) }),
    ];
    const result = compressWakeComments(comments, {
      maxCommentBodyChars: 1_500,
      enableTimeDecay: false,
      enableRelevanceScoring: false,
    });
    expect(result.savedChars).toBeGreaterThan(0);
  });
});
