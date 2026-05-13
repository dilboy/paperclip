import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDLE_AFTER_RESULT_MS,
  IDLE_AFTER_RESULT_ENV,
  resolveIdleAfterResultMs,
} from "./execute.js";
import { parseClaudeStreamJson } from "./parse.js";

const CLAUDE_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "session-idle-after-result",
  model: "claude-sonnet",
  result: "done",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  total_cost_usd: 0.0001,
});

describe("resolveIdleAfterResultMs", () => {
  it("defaults to 60_000 ms when neither env nor config is set", () => {
    expect(DEFAULT_IDLE_AFTER_RESULT_MS).toBe(60_000);
    expect(resolveIdleAfterResultMs({}, {})).toBe(60_000);
  });

  it("uses config.terminalResultCleanupGraceMs when set as a number", () => {
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: 1234 }, {}),
    ).toBe(1234);
  });

  it("accepts a numeric string as the config override", () => {
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: "2500" }, {}),
    ).toBe(2500);
  });

  it("ignores garbage config values and falls back to the default", () => {
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: "garbage" }, {}),
    ).toBe(DEFAULT_IDLE_AFTER_RESULT_MS);
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: -1 }, {}),
    ).toBe(DEFAULT_IDLE_AFTER_RESULT_MS);
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: Number.NaN }, {}),
    ).toBe(DEFAULT_IDLE_AFTER_RESULT_MS);
  });

  it("allows zero as a valid (immediate) grace", () => {
    expect(
      resolveIdleAfterResultMs({ terminalResultCleanupGraceMs: 0 }, {}),
    ).toBe(0);
    expect(
      resolveIdleAfterResultMs({}, { [IDLE_AFTER_RESULT_ENV]: "0" }),
    ).toBe(0);
  });

  it("prefers the env var over the config value", () => {
    expect(
      resolveIdleAfterResultMs(
        { terminalResultCleanupGraceMs: 1234 },
        { [IDLE_AFTER_RESULT_ENV]: "5678" },
      ),
    ).toBe(5678);
  });

  it("ignores invalid env values and falls back to config", () => {
    expect(
      resolveIdleAfterResultMs(
        { terminalResultCleanupGraceMs: 1234 },
        { [IDLE_AFTER_RESULT_ENV]: "garbage" },
      ),
    ).toBe(1234);
  });
});

describe("execute() idle-after-result wiring", () => {
  const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
    runChildProcess: vi.fn(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session-idle-after-result",
          model: "claude-sonnet",
        }),
        CLAUDE_RESULT_LINE,
      ].join("\n"),
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    })),
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "claude"),
  }));

  vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
      "@paperclipai/adapter-utils/server-utils",
    );
    return {
      ...actual,
      ensureCommandResolvable,
      resolveCommandForLogs,
      runChildProcess,
    };
  });

  const cleanupDirs: string[] = [];
  const originalEnvValue = process.env[IDLE_AFTER_RESULT_ENV];

  beforeEach(() => {
    runChildProcess.mockClear();
    delete process.env[IDLE_AFTER_RESULT_ENV];
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalEnvValue === undefined) {
      delete process.env[IDLE_AFTER_RESULT_ENV];
    } else {
      process.env[IDLE_AFTER_RESULT_ENV] = originalEnvValue;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  type RunOptions = Record<string, unknown> & {
    terminalResultCleanup?: { graceMs?: number; hasTerminalResult: (output: { stdout: string; stderr: string }) => boolean };
  };

  const runExecute = async (overrides?: { config?: Record<string, unknown> }) => {
    const { execute } = await import("./execute.js");
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-idle-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const result = await execute({
      runId: `run-${randomUUID()}`,
      agent: {
        id: "agent-idle",
        companyId: "company-idle",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { command: "claude", ...(overrides?.config ?? {}) },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], RunOptions]
      | undefined;
    return { result, call };
  };

  it("passes the 60 s default grace through to runChildProcess and returns a successful run", async () => {
    const { result, call } = await runExecute();
    expect(call).toBeDefined();
    const cleanup = call?.[3].terminalResultCleanup;
    expect(cleanup).toBeDefined();
    expect(cleanup?.graceMs).toBe(DEFAULT_IDLE_AFTER_RESULT_MS);
    expect(
      cleanup?.hasTerminalResult({
        stdout: `${CLAUDE_RESULT_LINE}\n`,
        stderr: "",
      }),
    ).toBe(true);
    expect(
      cleanup?.hasTerminalResult({ stdout: "noise\n", stderr: "" }),
    ).toBe(false);

    // Even though the child was killed (signal=SIGTERM) by the cleanup timer,
    // the adapter must surface a successful run: no errorCode, no timedOut, and
    // it should have parsed the terminal result block out of stdout.
    expect(result.errorCode ?? null).toBeNull();
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("done");
    expect(result.sessionId).toBe("session-idle-after-result");
  });

  it("respects the env-var override when set", async () => {
    process.env[IDLE_AFTER_RESULT_ENV] = "1234";
    const { call } = await runExecute();
    expect(call?.[3].terminalResultCleanup?.graceMs).toBe(1234);
  });

  it("respects the per-agent config override when env is unset", async () => {
    const { call } = await runExecute({
      config: { terminalResultCleanupGraceMs: 250 },
    });
    expect(call?.[3].terminalResultCleanup?.graceMs).toBe(250);
  });

  it("prefers the env var over the config override", async () => {
    process.env[IDLE_AFTER_RESULT_ENV] = "9000";
    const { call } = await runExecute({
      config: { terminalResultCleanupGraceMs: 250 },
    });
    expect(call?.[3].terminalResultCleanup?.graceMs).toBe(9000);
  });
});

describe("runChildProcess + Claude terminal-result predicate", () => {
  it.skipIf(process.platform === "win32")(
    "kills a still-running child after a Claude `result` block and reports timedOut=false",
    async () => {
      const { runChildProcess } = await import("@paperclipai/adapter-utils/server-utils");
      const script = [
        `process.stdout.write(${JSON.stringify(`${CLAUDE_RESULT_LINE}\n`)});`,
        "setInterval(() => {}, 1000);",
      ].join(" ");

      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        ["-e", script],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 0,
          graceSec: 1,
          onLog: async () => {},
          terminalResultCleanup: {
            graceMs: 100,
            hasTerminalResult: ({ stdout }) =>
              parseClaudeStreamJson(stdout).resultJson !== null,
          },
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGTERM");
      const parsed = parseClaudeStreamJson(result.stdout);
      expect(parsed.resultJson).not.toBeNull();
      expect(parsed.summary).toBe("done");
    },
    10_000,
  );
});
