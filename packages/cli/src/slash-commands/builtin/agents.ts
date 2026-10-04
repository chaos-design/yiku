import type { SessionSubagentProfile } from "@yiku/agent-orchestrator";
import type { LocalSlashCommand, SlashCommandResult } from "../types.js";

export const agentsCommand: LocalSlashCommand = {
  kind: "local",
  description: "List, inspect, remove, or run Agent Profiles",
  execution: "idle",
  execute: async (context, arguments_) => {
    const [subcommand = "list", profileId, ...taskParts] = arguments_.values;

    switch (subcommand) {
      case "list": {
        if (profileId !== undefined) {
          return usage();
        }
        const profiles = await context.listAgents();
        const lines = profiles.flatMap((profile) => [
          `• agents/${profile.name}`,
          `  • /agent:${profile.name}  ${profile.description}`,
        ]);
        return {
          kind: "success",
          ...(profiles.length > 0
            ? { lineColors: profiles.flatMap(() => ["white", "green"] as const) }
            : {}),
          message: profiles.length === 0 ? "No Agent Profiles." : lines.join("\n"),
          title: `Agents (${profiles.length})`,
        };
      }
      case "show": {
        if (profileId === undefined || taskParts.length > 0) {
          return usage();
        }
        return {
          kind: "success",
          message: formatDetails(await context.showAgent(profileId)),
          title: "Agent",
        };
      }
      case "remove": {
        if (profileId === undefined || taskParts.length > 0) {
          return usage();
        }
        await context.removeAgent(profileId);
        return {
          kind: "success",
          message: `Removed Subagent Profile ${profileId}.`,
          title: "Agent Removed",
        };
      }
      case "run": {
        if (profileId === undefined) {
          return usage();
        }
        const profile = await context.showAgent(profileId);
        const prompt = taskParts.join(" ").trim() || profile.deliverable;
        const result = await context.runAgent(profileId, prompt);
        return {
          kind: "success",
          message: [
            result.finalOutput,
            "",
            `Agent: ${result.agentId}`,
            `Task: ${result.taskId}`,
            `Status: ${result.status}`,
          ].join("\n"),
          title: "Agent Result",
        };
      }
      default:
        return usage();
    }
  },
  name: "agents",
  source: "builtin",
  progressLabel: "Managing Subagents...",
};

function formatDetails(profile: SessionSubagentProfile): string {
  return [
    `ID: ${profile.id}`,
    `Name: ${profile.name}`,
    `Type: ${profile.agentType}`,
    `Role: ${profile.role}`,
    `Description: ${profile.description}`,
    `Deliverable: ${profile.deliverable}`,
    `Purpose: ${profile.purpose}`,
    `Scopes: ${profile.scopes.join(", ")}`,
    `Invocation: ${profile.invocationMode}`,
    ...(profile.triggerInstructions !== undefined
      ? [`Trigger: ${profile.triggerInstructions}`]
      : []),
    `Model: ${profile.modelKey}`,
    `Access: ${profile.accessMode}`,
    `Created by: ${profile.createdBy}`,
    `Created at: ${profile.createdAt}`,
    `Source: ${profile.source}`,
    ...(profile.configPath !== undefined ? [`Config: ${profile.configPath}`] : []),
    `Skills: ${profile.skillSnapshots.map((skill) => `${skill.name}@${skill.version}`).join(", ") || "none"}`,
  ].join("\n");
}

function usage(): SlashCommandResult {
  return {
    kind: "error",
    message: "Usage: /agents [list|show <id>|remove <id>|run <id> [task]]",
    title: "Command Error",
  };
}
