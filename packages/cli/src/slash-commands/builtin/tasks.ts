import type { LocalSlashCommand } from "../types.js";

export const tasksCommand: LocalSlashCommand = {
  kind: "local",
  description: "Show task and prompt queue status",
  execute: (context, arguments_) =>
    arguments_.values.length === 0
      ? { kind: "success", message: context.getTaskSummary(), title: "Tasks" }
      : { kind: "error", message: "Usage: /tasks", title: "Command Error" },
  name: "tasks",
  source: "builtin",
};
