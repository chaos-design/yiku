import type { InteractiveSlashCommand, SlashCommandResult } from "../types.js";

export const mcpCommand: InteractiveSlashCommand = {
  description: "Inspect and reconnect MCP servers",
  execution: "idle",
  kind: "interactive",
  name: "mcp",
  open: async (context, arguments_) => {
    if (arguments_.values.length > 0) {
      return commandResult({
        kind: "error",
        message: "Usage: /mcp",
        title: "Command Error",
      });
    }

    const servers = [...(await context.runtime.mcpStatus())].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return {
      kind: "mcp-manager",
      onReconnect: async (server) => {
        await context.runtime.reconnectMcp(server);
        return [...(await context.runtime.mcpStatus())].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
      },
      servers,
      title: "MCP Servers",
    };
  },
  source: "builtin",
};

function commandResult(result: SlashCommandResult): SlashCommandResult {
  return result;
}
