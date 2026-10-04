import { tool } from "@openai/agents";
import { executeTool, type ToolCallMetadata } from "../common/middleware.js";
import { formatToolError } from "../common/output.js";
import { BashTerminal } from "./bash-terminal.js";
import {
  BASH_TERMINAL_TOOL_DEFINITION,
  type BashToolInput,
  type BashToolOptions,
  bashToolInputSchema,
} from "./types.js";

export function bashTool(options: BashToolOptions = {}) {
  const executor = options.executor ?? new BashTerminal(options);
  const name = options.name ?? BASH_TERMINAL_TOOL_DEFINITION.name;

  return tool({
    description: options.description ?? "Run a bash command. High-risk commands require approval.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: BashToolInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "process",
          execute: (resolved) =>
            executor.execute(resolved, {
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              ...(details?.toolCall?.callId !== undefined
                ? { toolCallId: details.toolCall.callId }
                : {}),
            }),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => bashToolInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: bashToolInputSchema,
    strict: true,
  });
}
