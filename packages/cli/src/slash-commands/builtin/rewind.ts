import type { InteractiveSlashCommand } from "../types.js";

export const rewindCommand: InteractiveSlashCommand = {
  description: "Restore a checkpoint and its Session history",
  execution: "idle",
  kind: "interactive",
  name: "rewind",
  open: async (context, arguments_) => {
    if (arguments_.values.length > 1) {
      return {
        kind: "error",
        message: "Usage: /rewind [checkpointId]",
        title: "Command Error",
      };
    }
    const checkpoints = await context.sessions.checkpoints();
    const checkpointId = arguments_.values[0];
    const visibleCheckpoints =
      checkpointId === undefined
        ? checkpoints
        : checkpoints.filter((checkpoint) => checkpoint.id === checkpointId);
    if (checkpointId !== undefined && visibleCheckpoints.length === 0) {
      return {
        kind: "error",
        message: `Checkpoint not found: ${checkpointId}`,
        title: "Command Error",
      };
    }
    return {
      checkpoints: visibleCheckpoints,
      kind: "checkpoint-picker",
      onSelect: async (selectedCheckpointId) => {
        await context.sessions.rewind(selectedCheckpointId);
        return rewound(selectedCheckpointId);
      },
      title: "Rewind Session",
    };
  },
  source: "builtin",
};

function rewound(checkpointId: string) {
  return {
    kind: "success" as const,
    message: `Rewound to checkpoint: ${checkpointId}`,
    title: "Session Rewound",
  };
}
