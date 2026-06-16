import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PreparedMiMoCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

export async function prepareMiMoCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedMiMoCodeRuntimeConfig> {
  // MiMoCode uses --dangerously-skip-permissions flag instead of config file
  // We don't need to create a temporary config dir - let MiMoCode use its default config
  return {
    env: input.env,
    notes: [],
    cleanup: async () => {},
  };
}
