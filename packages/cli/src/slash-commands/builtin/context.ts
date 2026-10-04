import type { LocalSlashCommand } from "../types.js";

export const contextCommand: LocalSlashCommand = {
  kind: "local",
  description: "Show current context usage",
  execute: (context, arguments_) => {
    if (arguments_.values.length > 0) {
      return { kind: "error", message: "Usage: /context", title: "Command Error" };
    }
    const contextUsage = context.getContextUsage();
    return {
      kind: "success",
      ...(contextUsage !== undefined ? { contextUsage } : {}),
      message:
        contextUsage === undefined ? context.getContextSummary() : "Context usage is calibrated.",
      title: "Context Usage",
    };
  },
  name: "context",
  source: "builtin",
};
