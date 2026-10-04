import type { LocalSlashCommand } from "../types.js";

export const statusCommand: LocalSlashCommand = {
  kind: "local",
  description: "Show session and runtime status",
  execute: (context, arguments_) =>
    arguments_.values.length === 0
      ? { kind: "success", message: context.getSessionStatus(), title: "Session Status" }
      : { kind: "error", message: "Usage: /status", title: "Command Error" },
  name: "status",
  source: "builtin",
};
