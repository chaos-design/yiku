import { tool } from "@openai/agents";
import type { z } from "zod";
import type { PermissionAssessment } from "../../permission/types.js";
import {
  asToolExecutionError,
  codeToolErrorResult,
  ToolInputValidationError,
  ToolJsonSyntaxError,
} from "./errors.js";
import {
  executeStructuredTool,
  type ToolCallMetadata,
  type ToolEffect,
  type ToolExecutionMiddleware,
} from "./middleware.js";

export interface CodeToolResult<TDisplay = unknown> {
  readonly display?: TDisplay | undefined;
  readonly error?:
    | {
        readonly code:
          | "TOOL_EXECUTION_ERROR"
          | "TOOL_INPUT_VALIDATION_ERROR"
          | "TOOL_JSON_SYNTAX_ERROR";
        readonly issues?:
          | readonly {
              readonly message: string;
              readonly path: string;
            }[]
          | undefined;
      }
    | undefined;
  readonly isError: boolean;
  readonly llmContent: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export type ToolApprovalPolicy = PermissionAssessment;

export interface ToolExecutionContext {
  readonly callId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeToolDefinition<TInput, TDisplay = unknown> {
  readonly approval: ToolApprovalPolicy;
  readonly description: string;
  readonly effect: ToolEffect | ((input: TInput) => ToolEffect);
  readonly name: string;
  readonly parameters: z.ZodType<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<CodeToolResult<TDisplay>>;
}

export interface InvokableCodeToolDefinition<TInput, TDisplay = unknown>
  extends CodeToolDefinition<TInput, TDisplay> {
  readonly invoke: (
    jsonInput: string,
    context?: ToolExecutionContext,
  ) => Promise<CodeToolResult<TDisplay>>;
  readonly run: (
    input: unknown,
    context?: ToolExecutionContext,
  ) => Promise<CodeToolResult<TDisplay>>;
}

export interface CodeToolOptions<TInput, TDisplay = unknown> {
  readonly approval?: ToolApprovalPolicy | undefined;
  readonly description?: string | undefined;
  readonly effect?: ToolEffect | ((input: TInput) => ToolEffect) | undefined;
  execute(input: TInput, context: ToolExecutionContext): Promise<CodeToolResult<TDisplay>>;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name: string;
  readonly parameters: z.ZodType<TInput>;
}

export function codeTool<TInput, TDisplay = unknown>(
  options: CodeToolOptions<TInput, TDisplay>,
): InvokableCodeToolDefinition<TInput, TDisplay> {
  const definition: CodeToolDefinition<TInput, TDisplay> = {
    approval: options.approval ?? "allow",
    description: options.description ?? `Execute ${options.name}.`,
    effect: options.effect ?? "external",
    execute: options.execute,
    name: options.name,
    parameters: options.parameters,
  };
  const run = (input: unknown, context: ToolExecutionContext = {}) =>
    runCodeTool(definition, input, context, options.middleware);

  return Object.freeze({
    ...definition,
    invoke: (jsonInput: string, context: ToolExecutionContext = {}) =>
      invokeCodeTool(jsonInput, context, run),
    run,
  });
}

export function toOpenAIAgentTool<TInput, TDisplay>(
  definition: InvokableCodeToolDefinition<TInput, TDisplay>,
) {
  return tool({
    description: definition.description,
    execute: async (input: unknown, _context, details?: ToolCallMetadata) => {
      const result = await definition.run(input, {
        ...(details?.toolCall?.callId !== undefined ? { callId: details.toolCall.callId } : {}),
        ...(details?.signal !== undefined ? { signal: details.signal } : {}),
      });
      return result.llmContent;
    },
    name: definition.name,
    parameters: definition.parameters as z.ZodObject,
    strict: true,
  });
}

async function invokeCodeTool<TDisplay>(
  jsonInput: string,
  context: ToolExecutionContext,
  run: (input: unknown, context: ToolExecutionContext) => Promise<CodeToolResult<TDisplay>>,
): Promise<CodeToolResult<TDisplay>> {
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(jsonInput);
  } catch (error) {
    return codeToolErrorResult(new ToolJsonSyntaxError(error));
  }

  return run(parsedInput, context);
}

async function runCodeTool<TInput, TDisplay>(
  definition: CodeToolDefinition<TInput, TDisplay>,
  parsedInput: unknown,
  context: ToolExecutionContext,
  middleware: ToolExecutionMiddleware | undefined,
): Promise<CodeToolResult<TDisplay>> {
  let input: TInput;
  try {
    input = parseToolInput(definition.parameters, parsedInput);
  } catch (error) {
    if (error instanceof ToolInputValidationError) {
      return codeToolErrorResult(error);
    }
    return codeToolErrorResult(asToolExecutionError(error));
  }

  try {
    const effect =
      typeof definition.effect === "function" ? definition.effect(input) : definition.effect;

    return await executeStructuredTool(
      {
        ...(context.callId !== undefined ? { callId: context.callId } : {}),
        effect,
        execute: (resolved) => definition.execute(resolved, context),
        input,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        toolName: definition.name,
        validate: (value) => parseToolInput(definition.parameters, value),
      },
      middleware,
    );
  } catch (error) {
    if (error instanceof ToolInputValidationError) {
      return codeToolErrorResult(error);
    }
    return codeToolErrorResult(asToolExecutionError(error));
  }
}

function parseToolInput<TInput>(parameters: z.ZodType<TInput>, input: unknown): TInput {
  const result = parameters.safeParse(input);
  if (!result.success) {
    throw new ToolInputValidationError(result.error.issues);
  }
  return result.data;
}
