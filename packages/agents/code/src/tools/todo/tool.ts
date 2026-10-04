import { tool } from "@openai/agents";
import { executeTool, type ToolCallMetadata } from "../common/middleware.js";
import { formatToolError } from "../common/output.js";
import { requireNonEmpty } from "../common/validation.js";
import {
  type TodoItem,
  type TodoToolExecutor,
  type TodoToolOptions,
  type TodoWriteToolInput,
  todoWriteToolInputSchema,
} from "./types.js";

export class TodoList implements TodoToolExecutor {
  private items: readonly TodoItem[] = [];

  public async write(input: TodoWriteToolInput): Promise<string> {
    const items = input.items.map((item) => ({
      content: requireNonEmpty(item.content, "TODO content is required."),
      status: item.status,
    }));
    const activeCount = items.filter((item) => item.status === "in_progress").length;

    if (activeCount > 1) {
      throw new Error("Only one TODO item can be in_progress.");
    }

    this.items = items;

    return formatTodoItems(this.items);
  }
}

export function todoWriteTool(options: TodoToolOptions = {}) {
  const executor = options.executor ?? new TodoList();
  const name = options.name ?? "todoWriteTool";

  return tool({
    description: options.description ?? "Replace the current TODO list with concise task items.",
    errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
    execute: (input: TodoWriteToolInput, _context?: unknown, details?: ToolCallMetadata) =>
      executeTool(
        {
          ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
          effect: "write",
          execute: (resolved) => executor.write(resolved),
          input,
          ...(details?.signal !== undefined ? { signal: details.signal } : {}),
          toolName: name,
          validate: (value) => todoWriteToolInputSchema.parse(value),
        },
        options.middleware,
      ),
    name,
    parameters: todoWriteToolInputSchema,
    strict: true,
  });
}

function formatTodoItems(items: readonly TodoItem[]): string {
  if (items.length === 0) {
    return "TODO list is empty.";
  }

  return items
    .map((item, index) => `${index + 1}. [${formatStatus(item.status)}] ${item.content}`)
    .join("\n");
}

function formatStatus(status: TodoItem["status"]): string {
  switch (status) {
    case "pending":
      return " ";
    case "in_progress":
      return "-";
    case "completed":
      return "x";
  }
}
