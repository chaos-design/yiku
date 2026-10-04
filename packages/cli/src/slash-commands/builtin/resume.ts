import type { InteractiveSlashCommand } from "../types.js";

export const resumeCommand: InteractiveSlashCommand = {
  description: "Resume another Session in this workspace",
  execution: "idle",
  kind: "interactive",
  name: "resume",
  open: async (context, arguments_) => {
    if (arguments_.values.length > 1) {
      return {
        kind: "error",
        message: "Usage: /resume [sessionId]",
        title: "Command Error",
      };
    }
    const sessionId = arguments_.values[0];
    if (sessionId !== undefined) {
      await context.sessions.switch(sessionId);
      return resumed(sessionId);
    }

    const [sessions, currentSessionId] = await Promise.all([
      context.sessions.list(),
      context.sessions.currentSessionId(),
    ]);
    return {
      ...(currentSessionId === undefined ? {} : { currentSessionId }),
      kind: "session-picker",
      onDelete: async (selectedSessionId) => {
        await context.sessions.remove(selectedSessionId);
        return {
          kind: "success",
          message: `Deleted Session: ${selectedSessionId}`,
          title: "Session Deleted",
        };
      },
      onRename: async (selectedSessionId, title) => {
        await context.sessions.rename(title, selectedSessionId);
        return {
          kind: "success",
          message: `Session renamed to: ${title}`,
          title: "Session Renamed",
        };
      },
      onSelect: async (selectedSessionId) => {
        await context.sessions.switch(selectedSessionId);
        return resumed(selectedSessionId);
      },
      sessions,
      title: "Resume Session",
    };
  },
  source: "builtin",
};

function resumed(sessionId: string) {
  return {
    kind: "success" as const,
    message: `Resumed Session: ${sessionId}`,
    title: "Session Resumed",
  };
}
