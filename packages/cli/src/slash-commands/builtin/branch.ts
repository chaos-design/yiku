import type { LocalSlashCommand } from "../types.js";

export const branchCommand: LocalSlashCommand = {
  description: "Branch the current Session",
  execution: "idle",
  execute: async (context, arguments_) => {
    const title = arguments_.values.join(" ").trim();
    await context.sessions.branch(title || undefined);
    const sessionId = await context.sessions.currentSessionId();
    return {
      kind: "success",
      message: `Branched to Session: ${sessionId ?? "new Session"}`,
      title: "Session Branched",
    };
  },
  kind: "local",
  name: "branch",
  source: "builtin",
};
