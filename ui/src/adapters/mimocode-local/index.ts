import type { UIAdapterModule } from "../types";
import { parseMiMoCodeStdoutLine, buildMiMoCodeLocalConfig } from "@paperclipai/adapter-mimocode-local/ui";
import { MiMoCodeLocalConfigFields } from "./config-fields";

export const miMoCodeLocalUIAdapter: UIAdapterModule = {
  type: "mimocode_local",
  label: "MiMoCode (local)",
  parseStdoutLine: parseMiMoCodeStdoutLine,
  ConfigFields: MiMoCodeLocalConfigFields,
  buildAdapterConfig: buildMiMoCodeLocalConfig,
};
