import type { LocalSlashCommand } from "../types.js";

export const compactCommand: LocalSlashCommand = {
  kind: "local",
  description: "Compact conversation context",
  execution: "idle",
  execute: async (context, arguments_) => {
    await context.compactContext(arguments_.raw.trim() || undefined);
    return { kind: "success", message: "Context compacted.", title: "Compact" };
  },
  name: "compact",
  source: "builtin",
  progressLabel: "Compacting context",
};
