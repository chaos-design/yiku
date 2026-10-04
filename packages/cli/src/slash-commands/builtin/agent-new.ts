import type { LocalSlashCommand } from "../types.js";

export const agentNewCommand: LocalSlashCommand = {
  kind: "local",
  description: "Create a user Agent Profile",
  execution: "idle",
  execute: async (context, arguments_) => {
    const intent = arguments_.raw.trim() || undefined;
    const profile = await context.createAgent(intent);
    return {
      kind: "success",
      lineColors: ["white", "white", "green"],
      message: [
        `ID: ${profile.id}`,
        `Name: ${profile.name}`,
        `Command: /agent:${profile.name}`,
        `Config: ${profile.configPath ?? "Session only"}`,
        `Type: ${profile.agentType}`,
        `Model: ${profile.modelKey}`,
        `Access: ${profile.accessMode}`,
        `Purpose: ${profile.purpose}`,
        `Scopes: ${profile.scopes.join(", ")}`,
        `Invocation: ${profile.invocationMode}`,
        `Skills: ${profile.skillSnapshots.map((skill) => skill.name).join(", ") || "none"}`,
      ].join("\n"),
      title: "Agent Created",
    };
  },
  name: "agent-new",
  source: "builtin",
  progressLabel: "Creating Subagent Profile...",
};
