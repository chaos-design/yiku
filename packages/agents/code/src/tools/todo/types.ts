import { z } from "zod";
import type { ToolExecutionMiddleware } from "../common/middleware.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(TODO_STATUSES),
});

export const todoWriteToolInputSchema = z.object({
  items: z.array(todoItemSchema),
});

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoWriteToolInput = z.infer<typeof todoWriteToolInputSchema>;

export interface TodoToolExecutor {
  readonly write: (input: TodoWriteToolInput) => Promise<string>;
}

export interface TodoToolOptions {
  readonly description?: string | undefined;
  readonly executor?: TodoToolExecutor | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}
