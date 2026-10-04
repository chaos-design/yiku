import type { LocalSlashCommand } from "../types.js";

export const exportCommand: LocalSlashCommand = {
  kind: "local",
  description: "Export the current session as Markdown",
  execution: "idle",
  execute: async (context, arguments_) => {
    if (arguments_.values.length > 1) {
      return {
        kind: "error",
        message: "Usage: /export [filePath]",
        title: "Command Error",
      };
    }

    const result = await context.exportSession(arguments_.values[0]);
    return {
      kind: "success",
      message: `Exported ${result.messageCount} messages to ${result.filePath}.`,
      title: "Session Exported",
    };
  },
  name: "export",
  progressLabel: "Exporting session",
  source: "builtin",
};
