import type { ShellProcessSandbox } from "@yiku/sandbox";
import { z } from "zod";
import type {
  PermissionApprovalHandler,
  PermissionAssessmentHandler,
  ShellIsolationLevel,
  ShellPolicy,
} from "../../permission/index.js";
import type { ToolExecutionMiddleware } from "../common/middleware.js";
import type { WorkspaceContext } from "../common/workspace-context.js";

export const BASH_TERMINAL_TOOL_DEFINITION = {
  name: "bashTool",
  type: "bash_20250124",
} as const;

export const DEFAULT_BASH_MAX_OUTPUT_CHARACTERS = 20_000;
export const DEFAULT_BASH_STARTUP_TIMEOUT_MS = 3_000;
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

export const bashToolInputSchema = z
  .object({
    command: z.string(),
  })
  .strict();

export type BashToolInput = z.infer<typeof bashToolInputSchema>;
export type BashCommandValidator = (command: string) => string | undefined;

export interface RuntimeBoundaryChange {
  readonly from: ShellIsolationLevel | "uninitialized";
  readonly reason: string;
  readonly to: ShellIsolationLevel;
}

export interface BashToolExecutionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly toolCallId?: string | undefined;
}

export interface BashToolExecutor {
  readonly execute: (input: BashToolInput, options?: BashToolExecutionOptions) => Promise<string>;
}

export interface BashTerminalOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fallbackSandbox?: ShellProcessSandbox | undefined;
  readonly maxOutputCharacters?: number | undefined;
  readonly onBoundaryChanged?:
    | ((change: RuntimeBoundaryChange) => Promise<void> | void)
    | undefined;
  readonly onCwdChanged?: ((cwd: string) => Promise<void> | void) | undefined;
  readonly permissionApprovalHandler?: PermissionApprovalHandler | undefined;
  readonly permissionAssessmentHandler?: PermissionAssessmentHandler | undefined;
  readonly shellPolicy?: ShellPolicy | undefined;
  readonly shellPath?: string | undefined;
  readonly shellSandbox?: ShellProcessSandbox | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly validateCommand?: BashCommandValidator | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}

export interface BashToolOptions extends BashTerminalOptions {
  readonly description?: string | undefined;
  readonly executor?: BashToolExecutor | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly name?: string | undefined;
}
