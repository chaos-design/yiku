import type { LocalSlashCommand } from "../types.js";

export const clearCommand: LocalSlashCommand = {
  kind: "local",
  aliases: ["reset"],
  description: "Clear messages and queued prompts",
  execution: "idle",
  execute: async (context) => {
    await context.clearSession();
    context.clearMessages();
    context.clearQueuedPrompts();
    return { kind: "success" };
  },
  name: "clear",
  source: "builtin",
};
