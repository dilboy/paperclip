import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { parseMiMoCodeJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const MIMOCODE_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|mimo\s+providers|free\s+usage\s+exceeded)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "mimo");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `mimocode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "mimocode_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "mimocode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "mimocode_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (asBoolean(config.dangerouslySkipPermissions, true)) {
    checks.push({
      code: "mimocode_headless_permissions_enabled",
      level: "info",
      message: "Headless MiMoCode external-directory permissions are auto-approved for unattended runs.",
    });
  }

  let restoreWorkspace: (() => Promise<void>) | null = null;
  let preparedRuntimeWorkspaceLocalDir: string | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target ?? null;
    let runtimeCwd = cwd;
    if (targetIsRemote) {
      preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-mimocode-envtest-${runId}-`));
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "mimocode",
        workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
        workspaceRemoteDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
        if (preparedRuntimeWorkspaceLocalDir) {
          await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? runtimeCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target ?? null, runtimeCwd) ?? null;
    }
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

    const cwdInvalid = checks.some((check) => check.code === "mimocode_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "mimocode_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      const installCheck = await maybeRunSandboxInstallCommand({
        runId,
        target,
        adapterKey: "mimocode",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        env,
      });
      if (installCheck) checks.push(installCheck);
      try {
        await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
        checks.push({
          code: "mimocode_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "mimocode_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "mimocode_cwd_invalid" && check.code !== "mimocode_command_unresolvable");

    const configuredModel = asString(config.model, "").trim();

    if (canRunProbe && configuredModel) {
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const variant = asString(config.variant, "").trim();
      const probeModel = configuredModel;

      const args = ["run", "--format", "json"];
      args.push("--model", probeModel);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);

      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));

      try {
        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          args,
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: helloProbeTimeoutSec,
            graceSec: 5,
            stdin: "Respond with hello.",
            onLog: async () => {},
          },
        );

        const parsed = parseMiMoCodeJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "mimocode_hello_probe_timed_out",
            level: "warn",
            message: "MiMoCode hello probe timed out.",
            hint: "Retry the probe. If this persists, run MiMoCode manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "mimocode_hello_probe_passed" : "mimocode_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "MiMoCode hello probe succeeded."
              : "MiMoCode probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `mimo run --format json` manually and prompt `Respond with hello` to inspect output.",
                }),
          });
        } else if (MIMOCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "mimocode_hello_probe_auth_required",
            level: "warn",
            message: "MiMoCode is installed, but provider authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Run `mimo providers` or set provider credentials, then retry the probe.",
          });
        } else {
          checks.push({
            code: "mimocode_hello_probe_failed",
            level: "error",
            message: "MiMoCode hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `mimo run --format json` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "mimocode_hello_probe_failed",
          level: "error",
          message: "MiMoCode hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `mimo run --format json` manually in this working directory to debug.",
        });
      }
    }
  } finally {
    await restoreWorkspace?.();
    if (!restoreWorkspace && preparedRuntimeWorkspaceLocalDir) {
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
