import type { z } from "zod";
import type { CodeToolResult } from "./definition.js";

export const MAX_TOOL_VALIDATION_ISSUES = 20;

export type CodeToolErrorCode =
  | "TOOL_EXECUTION_ERROR"
  | "TOOL_INPUT_VALIDATION_ERROR"
  | "TOOL_JSON_SYNTAX_ERROR";

export interface CodeToolValidationIssue {
  readonly message: string;
  readonly path: string;
}

export abstract class CodeToolError extends Error {
  public abstract readonly code: CodeToolErrorCode;
}

export class ToolJsonSyntaxError extends CodeToolError {
  public readonly code = "TOOL_JSON_SYNTAX_ERROR" as const;
  public override readonly name = "ToolJsonSyntaxError";

  public constructor(error: unknown) {
    super(`Invalid JSON input for tool: ${errorMessage(error)}`);
  }
}

export class ToolInputValidationError extends CodeToolError {
  public readonly code = "TOOL_INPUT_VALIDATION_ERROR" as const;
  public override readonly name = "ToolInputValidationError";
  public readonly issues: readonly CodeToolValidationIssue[];

  public constructor(issues: readonly z.ZodIssue[]) {
    const normalizedIssues = normalizeZodIssues(issues);
    const firstIssue = normalizedIssues[0];
    super(
      firstIssue === undefined
        ? "Tool input validation failed."
        : `Invalid tool input${firstIssue.path ? ` at ${firstIssue.path}` : ""}: ${firstIssue.message}`,
    );
    this.issues = normalizedIssues;
  }
}

export class ToolExecutionError extends CodeToolError {
  public readonly code = "TOOL_EXECUTION_ERROR" as const;
  public override readonly name = "ToolExecutionError";

  public constructor(error: unknown) {
    super(`Tool execution failed: ${errorMessage(error)}`);
  }
}

export function asToolExecutionError(error: unknown): ToolExecutionError {
  return error instanceof ToolExecutionError ? error : new ToolExecutionError(error);
}

export function codeToolErrorResult(error: CodeToolError): CodeToolResult<never> {
  return {
    error: {
      code: error.code,
      ...(error instanceof ToolInputValidationError ? { issues: error.issues } : {}),
    },
    isError: true,
    llmContent: error.message,
  };
}

export function toolExecutionErrorResult(error: unknown): CodeToolResult<never> {
  return {
    error: { code: "TOOL_EXECUTION_ERROR" },
    isError: true,
    llmContent: errorMessage(error),
  };
}

function normalizeZodIssues(issues: readonly z.ZodIssue[]): readonly CodeToolValidationIssue[] {
  return Object.freeze(
    issues.slice(0, MAX_TOOL_VALIDATION_ISSUES).map((issue) =>
      Object.freeze({
        message: issue.message,
        path: issue.path.map(String).join("."),
      }),
    ),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
