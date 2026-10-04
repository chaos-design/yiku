import type { LocalSlashCommand } from "../types.js";

export const initCommand: LocalSlashCommand = {
  kind: "local",
  description: "Run project setup",
  execution: "idle",
  execute: async (context, arguments_) => {
    if (arguments_.values.length > 0) {
      return { kind: "error", message: "Usage: /init", title: "Command Error" };
    }
    await context.runSetup("init");
    return { kind: "success", message: "Project setup completed.", title: "Project Setup" };
  },
  name: "init",
  source: "builtin",
};
