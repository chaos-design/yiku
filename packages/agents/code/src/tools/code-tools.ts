import type { Tool } from "@openai/agents";
import type { ShellProcessSandbox } from "@yiku/sandbox";
import type {
  PermissionApprovalHandler,
  PermissionAssessmentHandler,
  WorkspaceAccessMode,
} from "../permission/index.js";
import { toOpenAIAgentTool } from "./common/definition.js";
import type { ToolExecutionMiddleware } from "./common/middleware.js";
import { WorkspaceContext } from "./common/workspace-context.js";
import { editTool, TextFileOperations, writeTool } from "./edit/index.js";
import { grepTool, lsTool, treeTool } from "./fs/index.js";
import { readTool } from "./read/index.js";
import { BashTerminal } from "./terminal/bash-terminal.js";
import { bashTool } from "./terminal/index.js";
import type { RuntimeBoundaryChange } from "./terminal/types.js";
import { todoWriteTool } from "./todo/index.js";
import type { TodoToolExecutor } from "./todo/types.js";
import { askUserTool } from "./user-question/index.js";
import type { UserQuestionHandler } from "./user-question/types.js";

export type CodeToolAccessMode = WorkspaceAccessMode;

export interface CodeToolsOptions {
  readonly accessMode?: CodeToolAccessMode | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly onBoundaryChanged?:
    | ((change: RuntimeBoundaryChange) => Promise<void> | void)
    | undefined;
  readonly onCwdChanged?: ((cwd: string) => Promise<void> | void) | undefined;
  readonly permissionApprovalHandler?: PermissionApprovalHandler | undefined;
  readonly permissionAssessmentHandler?: PermissionAssessmentHandler | undefined;
  readonly shellSandbox?: ShellProcessSandbox | undefined;
  readonly todoExecutor?: TodoToolExecutor | undefined;
  readonly userQuestionHandler?: UserQuestionHandler | undefined;
  readonly workspace?: WorkspaceContext | undefined;
}

export class CodeToolset {
  public readonly tools: readonly Tool[];
  private readonly bashTerminal?: BashTerminal | undefined;

  public constructor(options: CodeToolsOptions = {}) {
    const accessMode = options.accessMode ?? options.workspace?.accessMode ?? "read-write";
    if (options.workspace !== undefined && options.workspace.accessMode !== accessMode) {
      throw new Error("Code Tool access mode must match the Workspace Context.");
    }
    const workspace =
      options.workspace ??
      new WorkspaceContext({
        accessMode,
        rootDir: process.cwd(),
      });
    const textFileOperations = new TextFileOperations({ workspace });

    this.bashTerminal = new BashTerminal({
      ...(options.onBoundaryChanged !== undefined
        ? { onBoundaryChanged: options.onBoundaryChanged }
        : {}),
      ...(options.onCwdChanged !== undefined ? { onCwdChanged: options.onCwdChanged } : {}),
      ...(options.permissionApprovalHandler !== undefined
        ? { permissionApprovalHandler: options.permissionApprovalHandler }
        : {}),
      ...(options.permissionAssessmentHandler !== undefined
        ? { permissionAssessmentHandler: options.permissionAssessmentHandler }
        : {}),
      ...(options.shellSandbox !== undefined ? { shellSandbox: options.shellSandbox } : {}),
      workspace,
    });
    this.tools = Object.freeze([
      bashTool({ executor: this.bashTerminal, middleware: options.middleware }),
      grepTool({ middleware: options.middleware, workspace }),
      lsTool({ middleware: options.middleware, workspace }),
      toOpenAIAgentTool(
        readTool({
          executor: textFileOperations,
          middleware: options.middleware,
        }),
      ),
      toOpenAIAgentTool(
        editTool({
          executor: textFileOperations,
          middleware: options.middleware,
        }),
      ),
      toOpenAIAgentTool(
        writeTool({
          executor: textFileOperations,
          middleware: options.middleware,
        }),
      ),
      todoWriteTool({
        ...(options.todoExecutor !== undefined ? { executor: options.todoExecutor } : {}),
        middleware: options.middleware,
      }),
      treeTool({ middleware: options.middleware, workspace }),
      askUserTool({
        handler: options.userQuestionHandler,
        middleware: options.middleware,
        name: "askUserTool",
      }),
    ]);
  }

  public close(): void {
    this.bashTerminal?.close();
  }
}

export function codeTools(options: CodeToolsOptions = {}): readonly Tool[] {
  return new CodeToolset(options).tools;
}
