import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function nowTs(): string {
  return new Date().toISOString();
}

export function parseMiMoCodeTranscript(stdout: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const ts = nowTs();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJsonLine(line);
    if (!event) continue;

    const type = asString(event.type);

    if (type === "text") {
      const part = event.part as Record<string, unknown> | undefined;
      const text = asString(part?.text);
      if (text) {
        entries.push({
          kind: "assistant",
          ts,
          text,
        });
      }
      continue;
    }

    if (type === "tool_use") {
      const part = event.part as Record<string, unknown> | undefined;
      const name = asString(part?.name);
      const state = part?.state as Record<string, unknown> | undefined;
      const status = asString(state?.status);
      const toolUseId = asString(part?.id);

      if (name) {
        entries.push({
          kind: "tool_call",
          ts,
          name,
          input: part?.input ?? {},
          ...(toolUseId ? { toolUseId } : {}),
        });
      }
      continue;
    }

    if (type === "step_finish") {
      const part = event.part as Record<string, unknown> | undefined;
      const tokens = part?.tokens as Record<string, unknown> | undefined;
      const cache = tokens?.cache as Record<string, unknown> | undefined;
      entries.push({
        kind: "result",
        ts,
        text: "",
        inputTokens: asNumber(tokens?.input),
        outputTokens: asNumber(tokens?.output) + asNumber(tokens?.reasoning),
        cachedTokens: asNumber(cache?.read),
        costUsd: asNumber(part?.cost),
        subtype: "turn_complete",
        isError: false,
        errors: [],
      });
      continue;
    }

    if (type === "error") {
      const errorObj = event.error ?? event.message;
      const text = typeof errorObj === "string" ? errorObj : asString(errorObj);
      if (text) {
        entries.push({
          kind: "result",
          ts,
          text,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          subtype: "error",
          isError: true,
          errors: [text],
        });
      }
      continue;
    }
  }

  return entries;
}
