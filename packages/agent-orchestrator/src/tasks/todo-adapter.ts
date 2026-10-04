import type { TodoItem, TodoToolExecutor, TodoWriteToolInput } from "@yiku/agent-code";
import type { TaskRegistry } from "./task-registry.js";

export interface TodoAdapterOptions {
  readonly registry: TaskRegistry;
}

export class TodoAdapter implements TodoToolExecutor {
  public constructor(private readonly options: TodoAdapterOptions) {}

  public async write(input: TodoWriteToolInput): Promise<string> {
    const items = validateItems(input.items);
    const tasks = await this.options.registry.reconcile(
      items.map((item) => ({
        status: item.status,
        subject: item.content,
      })),
    );

    if (tasks.length === 0) {
      return "TODO list is empty.";
    }
    return tasks
      .map((task, index) => `${index + 1}. [${formatStatus(task.status)}] ${task.subject}`)
      .join("\n");
  }
}

function validateItems(items: readonly TodoItem[]): readonly TodoItem[] {
  const normalized = items.map((item) => ({
    content: requireText(item.content),
    status: item.status,
  }));
  if (normalized.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one TODO item can be in_progress.");
  }
  return normalized;
}

function requireText(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("TODO content is required.");
  }
  return normalized;
}

function formatStatus(status: "blocked" | "completed" | "in_progress" | "pending"): string {
  switch (status) {
    case "blocked":
      return "!";
    case "completed":
      return "x";
    case "in_progress":
      return "-";
    case "pending":
      return " ";
  }
}
