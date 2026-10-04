import type { LocalSlashCommand } from "../types.js";

export const doctorCommand: LocalSlashCommand = {
  kind: "local",
  aliases: ["checkup"],
  description: "Run project maintenance checks",
  execution: "idle",
  execute: async (context, arguments_) => {
    if (arguments_.values.length > 0) {
      return { kind: "error", message: "Usage: /doctor", title: "Command Error" };
    }
    await context.runSetup("maintenance");
    return {
      kind: "success",
      message: "Project maintenance completed.",
      title: "Doctor",
    };
  },
  name: "doctor",
  source: "builtin",
};
