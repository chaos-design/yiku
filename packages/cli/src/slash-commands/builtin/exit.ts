import type { LocalSlashCommand } from "../types.js";

export const exitCommand: LocalSlashCommand = {
  kind: "local",
  aliases: ["quit"],
  description: "Exit the CLI",
  execute: (context) => {
    context.onExitCode(0);
    context.exit();
    return { kind: "success" };
  },
  name: "exit",
  source: "builtin",
};
