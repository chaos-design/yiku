import type { LocalSlashCommand } from "../types.js";

export const helpCommand: LocalSlashCommand = {
  kind: "local",
  description: "Show available slash commands",
  execute: (context) => {
    const helpText = context
      .listCommands()
      .map((command) => `/${command.name}  ${command.description}`)
      .join("\n");

    return { kind: "success", message: helpText, title: "Commands" };
  },
  name: "help",
  source: "builtin",
};
