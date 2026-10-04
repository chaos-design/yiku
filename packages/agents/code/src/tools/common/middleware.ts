import type { CodeToolResult } from "./definition.js";

export interface ToolCallMetadata {
  readonly signal?: AbortSignal | undefined;
  readonly toolCall?: { readonly callId?: string | undefined } | undefined;
}

export type ToolEffect = "external" | "process" | "read" | "write";

export interface ToolExecutionRequest<TInput, TOutput = CodeToolResult> {
  readonly callId?: string | undefined;
  readonly effect?: ToolEffect | undefined;
  readonly input: TInput;
  readonly signal?: AbortSignal | undefined;
  readonly toolName: string;
  execute(input: TInput): Promise<TOutput>;
  validate(input: unknown): TInput;
}

export interface ToolExecutionMiddleware {
  run<TInput, TOutput>(request: ToolExecutionRequest<TInput, TOutput>): Promise<TOutput>;
}

export interface CompatibleToolExecutionRequest<TInput, TOutput> {
  readonly callId?: string | undefined;
  readonly effect?: ToolEffect | undefined;
  readonly input: TInput;
  readonly signal?: AbortSignal | undefined;
  readonly toolName: string;
  execute(input: TInput): Promise<TOutput>;
  validate(input: unknown): TInput;
}

const COMPATIBLE_OUTPUT = Symbol("compatibleToolOutput");

type CompatibleCodeToolResult<TOutput> = CodeToolResult & {
  readonly [COMPATIBLE_OUTPUT]: TOutput;
};

export function executeStructuredTool<TInput, TDisplay>(
  request: ToolExecutionRequest<TInput, CodeToolResult<TDisplay>>,
  middleware?: ToolExecutionMiddleware | undefined,
): Promise<CodeToolResult<TDisplay>> {
  return middleware === undefined ? request.execute(request.input) : middleware.run(request);
}

export function unwrapCodeToolResult<TDisplay>(result: CodeToolResult<TDisplay>): string {
  return result.llmContent;
}

export async function executeTool<TInput, TOutput>(
  request: CompatibleToolExecutionRequest<TInput, TOutput>,
  middleware?: ToolExecutionMiddleware | undefined,
): Promise<TOutput> {
  if (middleware === undefined) {
    return request.execute(request.input);
  }

  const result = await middleware.run({
    ...(request.callId !== undefined ? { callId: request.callId } : {}),
    ...(request.effect !== undefined ? { effect: request.effect } : {}),
    execute: async (input) => compatibleCodeToolResult(await request.execute(input)),
    input: request.input,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    toolName: request.toolName,
    validate: request.validate,
  });

  return compatibleOutput(result);
}

function compatibleCodeToolResult<TOutput>(output: TOutput): CompatibleCodeToolResult<TOutput> {
  return {
    [COMPATIBLE_OUTPUT]: output,
    isError: false,
    llmContent: formatCompatibleOutput(output),
  };
}

function compatibleOutput<TOutput>(result: CodeToolResult): TOutput {
  if (COMPATIBLE_OUTPUT in result) {
    return (result as CompatibleCodeToolResult<TOutput>)[COMPATIBLE_OUTPUT];
  }

  return result.llmContent as TOutput;
}

function formatCompatibleOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (output == null) {
    return "";
  }

  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
