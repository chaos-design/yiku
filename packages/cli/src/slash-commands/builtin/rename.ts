import type { LocalSlashCommand } from "../types.js";

export const renameCommand: LocalSlashCommand = {
  description: "Rename the current Session",
  execution: "idle",
  execute: async (context, arguments_) => {
    const title = arguments_.values.join(" ").trim();
    if (!title) {
      return {
        kind: "error",
        message: "Usage: /rename <title>",
        title: "Command Error",
      };
    }
    await context.sessions.rename(title);
    return {
      kind: "success",
      message: `Session renamed to: ${title}`,
      title: "Session Renamed",
    };
  },
  kind: "local",
  name: "rename",
  source: "builtin",
};
