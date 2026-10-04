import type { LocalSlashCommand } from "../types.js";

export const usageCommand: LocalSlashCommand = {
  kind: "local",
  aliases: ["cost"],
  description: "Show token and tool usage",
  execute: (context, arguments_) =>
    arguments_.values.length === 0
      ? { kind: "success", message: context.getUsageSummary(), title: "Usage" }
      : { kind: "error", message: "Usage: /usage", title: "Command Error" },
  name: "usage",
  source: "builtin",
};
