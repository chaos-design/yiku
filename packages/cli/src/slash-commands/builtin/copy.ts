import type { LocalSlashCommand } from "../types.js";

export const copyCommand: LocalSlashCommand = {
  kind: "local",
  description: "Copy the last assistant message to the clipboard",
  execute: async (context, arguments_) => {
    if (arguments_.values.length > 0) {
      return { kind: "error", message: "Usage: /copy", title: "Command Error" };
    }

    const text = context.lastAssistantText();
    if (text === undefined) {
      return {
        kind: "error",
        message: "No assistant message to copy.",
        title: "Command Error",
      };
    }

    await context.clipboard.write(text);
    const lineCount = text.split(/\r\n|\r|\n/u).length;
    return {
      kind: "success",
      message: `Copied ${text.length} characters across ${lineCount} lines.`,
      title: "Copied",
    };
  },
  name: "copy",
  source: "builtin",
};
