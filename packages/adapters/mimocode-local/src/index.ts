import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "mimocode_local";
export const label = "MiMoCode (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g mimocode";

export const DEFAULT_MIMOCODE_MODEL = "mimo/mimo-auto";

export function isValidMiMoCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_MIMOCODE_MODEL, label: "MiMo Auto" },
  { id: "xiaomi/mimo-v2-flash", label: "MiMo V2 Flash" },
  { id: "xiaomi/mimo-v2-omni", label: "MiMo V2 Omni" },
  { id: "xiaomi/mimo-v2-pro", label: "MiMo V2 Pro" },
  { id: "xiaomi/mimo-v2.5", label: "MiMo V2.5" },
  { id: "xiaomi/mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
  { id: "xiaomi/mimo-v2.5-pro-ultraspeed", label: "MiMo V2.5 Pro UltraSpeed" },
];

export const DEFAULT_MIMOCODE_CHEAP_MODEL = "xiaomi/mimo-v2-flash";

export function buildMiMoCodeModelProfiles(
  env: NodeJS.ProcessEnv = typeof process === "undefined" ? {} : process.env,
): AdapterModelProfileDefinition[] {
  const override = (env.PAPERCLIP_MIMOCODE_CHEAP_MODEL ?? env.PAPERCLIP_MIMOCODE_SMALL_MODEL)?.trim();
  return [
    {
      key: "cheap",
      label: "Cheap",
      description: "Budget lane model for recovery retries and other low-cost tasks.",
      adapterConfig: override
        ? { model: override }
        : { model: DEFAULT_MIMOCODE_CHEAP_MODEL, variant: "low" },
      source: "adapter_default",
    },
  ];
}

export const modelProfiles: AdapterModelProfileDefinition[] = buildMiMoCodeModelProfiles();

export const agentConfigurationDoc = `# mimocode_local agent configuration

Adapter: mimocode_local

Use when:
- You want Paperclip to run MiMoCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want MiMoCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- MiMoCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): MiMoCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): inject a runtime MiMoCode config that allows external_directory access without interactive prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "mimo"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- MiMoCode is built on OpenCode and uses similar CLI patterns.
- Use mimo models to list available options in provider/model format.
- Runs are executed with: mimo run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets MIMOCODE_DISABLE_PROJECT_CONFIG=true to prevent MiMoCode from \
  writing a config file into the project working directory. Model selection is \
  passed via the --model CLI flag instead.
- When dangerouslySkipPermissions is enabled, Paperclip injects a temporary \
  runtime config with permission.external_directory=allow so headless runs do \
  not stall on approval prompts.
`;
