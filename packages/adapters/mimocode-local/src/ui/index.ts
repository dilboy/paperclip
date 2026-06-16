import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const msg =
    asString(rec.message) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseToolUse(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const part = asRecord(parsed.part);
  if (!part) return [{ kind: "system", ts, text: "tool event" }];

  const toolName = asString(part.name, "tool");
  const state = asRecord(part.state);
  const input = state?.input ?? {};
  const callEntry: TranscriptEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    toolUseId: asString(part.id) || undefined,
    input,
  };

  const status = asString(state?.status);
  if (status !== "completed" && status !== "error") return [callEntry];

  const rawOutput =
    asString(state?.output) ||
    asString(state?.error) ||
    asString(part.title) ||
    `${toolName} ${status}`;

  const metadata = asRecord(state?.metadata);
  const headerParts: string[] = [`status: ${status}`];
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) headerParts.push(`${key}: ${value}`);
    }
  }
  const content = `${headerParts.join("\n")}\n\n${rawOutput}`.trim();

  return [
    callEntry,
    {
      kind: "tool_result",
      ts,
      toolUseId: asString(part.id, toolName),
      content,
      isError: status === "error",
    },
  ];
}

export function parseMiMoCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "thinking", ts, text }];
  }

  if (type === "tool_use") {
    return parseToolUse(parsed, ts);
  }

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    return [
      {
        kind: "system",
        ts,
        text: `step started${sessionId ? ` (${sessionId})` : ""}`,
      },
    ];
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = asString(part?.reason, "step");
    const output = asNumber(tokens?.output, 0) + asNumber(tokens?.reasoning, 0);
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: asNumber(tokens?.input, 0),
        outputTokens: output,
        cachedTokens: asNumber(cache?.read, 0),
        costUsd: asNumber(part?.cost, 0),
        subtype: reason,
        isError: false,
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

export function buildMiMoCodeLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.variant = v.thinkingEffort;
  ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions !== false;
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
