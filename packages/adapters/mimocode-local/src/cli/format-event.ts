import chalk from "picocolors";

export function formatStdoutEvent(line: string, debug: boolean): void {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "text") {
      const part = event.part as Record<string, unknown> | undefined;
      const text = typeof part?.text === "string" ? part.text : "";
      if (text) {
        console.log(text);
      }
      return;
    }

    if (type === "tool_use") {
      const part = event.part as Record<string, unknown> | undefined;
      const name = typeof part?.name === "string" ? part.name : "unknown";
      const state = part?.state as Record<string, unknown> | undefined;
      const status = typeof state?.status === "string" ? state.status : "";

      if (status === "error") {
        const error = typeof state?.error === "string" ? state.error : "unknown error";
        console.log(chalk.red(`  ✗ ${name}: ${error}`));
      } else {
        console.log(chalk.green(`  ✓ ${name}`));
      }
      return;
    }

    if (type === "error") {
      const errorObj = event.error ?? event.message;
      const text = typeof errorObj === "string" ? errorObj : JSON.stringify(errorObj);
      console.log(chalk.red(`  Error: ${text}`));
      return;
    }

    if (debug) {
      console.log(chalk.gray(`  [${type}]`));
    }
  } catch {
    if (debug) {
      console.log(chalk.gray(`  ${line}`));
    }
  }
}
