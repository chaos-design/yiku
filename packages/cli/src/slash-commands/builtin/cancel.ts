import type { LocalSlashCommand } from "../types.js";

export const cancelCommand: LocalSlashCommand = {
  kind: "local",
  description: "Cancel the current running task",
  execute: (context) => {
    context.cancelActiveRun();
    return { kind: "success" };
  },
  name: "cancel",
  source: "builtin",
};
