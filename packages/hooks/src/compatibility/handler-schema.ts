import { z } from "zod";
import type {
  AgentHookHandler,
  CommandHookHandler,
  HttpHookHandler,
  McpHookHandler,
  PromptHookHandler,
} from "../types.js";
import { jsonObjectSchema } from "./event-schema.js";

export type ConfiguredHookHandler =
  | AgentHookHandler
  | CommandHookHandler
  | HttpHookHandler
  | McpHookHandler
  | PromptHookHandler;

const commonShape = {
  if: z.string().min(1).optional(),
  once: z.boolean().optional(),
  statusMessage: z.string().min(1).optional(),
  timeout: z.number().finite().positive().optional(),
};

const commandHookHandlerSchema = z
  .object({
    ...commonShape,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    command: z.string().min(1),
    shell: z.string().min(1).optional(),
    type: z.literal("command"),
  })
  .strict()
  .superRefine((handler, context) => {
    if (handler.asyncRewake === true && handler.async !== true) {
      context.addIssue({
        code: "custom",
        message: "asyncRewake requires async=true.",
        path: ["asyncRewake"],
      });
    }
  });

const httpHookHandlerSchema = z
  .object({
    ...commonShape,
    allowedEnvVars: z.array(z.string().min(1)).optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    type: z.literal("http"),
    url: z.url(),
  })
  .strict();

const promptHookHandlerSchema = z
  .object({
    ...commonShape,
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    type: z.literal("prompt"),
  })
  .strict();

const agentHookHandlerSchema = z
  .object({
    ...commonShape,
    maxTurns: z.number().int().positive().max(50).optional(),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    type: z.literal("agent"),
  })
  .strict();

const mcpHookHandlerSchema = z
  .object({
    ...commonShape,
    arguments: jsonObjectSchema.optional(),
    server: z.string().min(1),
    tool: z.string().min(1),
    type: z.literal("mcp"),
  })
  .strict();

export const hookHandlerSchema = z.union([
  commandHookHandlerSchema,
  httpHookHandlerSchema,
  promptHookHandlerSchema,
  agentHookHandlerSchema,
  mcpHookHandlerSchema,
]);

export const HOOK_HANDLER_SCHEMAS = Object.freeze({
  agent: agentHookHandlerSchema,
  command: commandHookHandlerSchema,
  http: httpHookHandlerSchema,
  mcp: mcpHookHandlerSchema,
  prompt: promptHookHandlerSchema,
});

export function parseHookHandler(value: unknown): ConfiguredHookHandler {
  return hookHandlerSchema.parse(value) as ConfiguredHookHandler;
}
