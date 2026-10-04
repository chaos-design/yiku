import { randomUUID } from "node:crypto";
import type { ToolExecutionMiddleware, ToolExecutionRequest } from "@yiku/agent-code";
import type {
  HookEventBase,
  HookPermissionMode,
  HookSession,
  JsonObject,
  JsonValue,
} from "@yiku/hooks";
import type { ToolBatchTracker } from "./tool-batch.js";

export interface ToolHookContext {
  readonly cwd: string;
  readonly hookSession: HookSession;
  readonly permissionMode: HookPermissionMode;
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export class HookToolBlockedError extends Error {
  public override readonly name = "HookToolBlockedError";

  public constructor(
    public readonly toolName: string,
    public readonly toolUseId: string,
    message: string,
  ) {
    super(message);
  }
}

export class ToolHookMiddleware implements ToolExecutionMiddleware {
  public constructor(
    private readonly context: ToolHookContext,
    private readonly batch: ToolBatchTracker,
  ) {}

  public async run<TInput, TOutput>(
    request: ToolExecutionRequest<TInput, TOutput>,
  ): Promise<TOutput> {
    const toolUseId = request.callId ?? randomUUID();
    const toolInput = toJsonObject(request.input);
    const preDecision = await this.context.hookSession.dispatch({
      ...this.eventBase("PreToolUse"),
      hook_event_name: "PreToolUse",
      tool_input: toolInput,
      tool_name: request.toolName,
      tool_use_id: toolUseId,
    });

    if (preDecision.action === "block" || preDecision.action === "stop") {
      throw new HookToolBlockedError(
        request.toolName,
        toolUseId,
        preDecision.reasons.join("; ") || `Hook blocked ${request.toolName}.`,
      );
    }

    if (preDecision.action === "defer") {
      throw new HookToolBlockedError(
        request.toolName,
        toolUseId,
        `Hook deferred ${request.toolName}; deferred scheduling is not available in this turn.`,
      );
    }

    const mergedInput =
      preDecision.updatedInput === undefined
        ? request.input
        : request.validate({
            ...toJsonObject(request.input),
            ...preDecision.updatedInput,
          });
    this.batch.begin(toolUseId);

    try {
      const output = await request.execute(mergedInput);
      await this.context.hookSession.dispatch({
        ...this.eventBase("PostToolUse"),
        hook_event_name: "PostToolUse",
        tool_input: toJsonObject(mergedInput),
        tool_name: request.toolName,
        tool_response: toJsonValue(output),
        tool_use_id: toolUseId,
      });
      this.batch.finish(toolUseId, request.toolName, "succeeded");
      return output;
    } catch (error) {
      try {
        await this.context.hookSession.dispatch({
          ...this.eventBase("PostToolUseFailure"),
          error: error instanceof Error ? error.message : String(error),
          hook_event_name: "PostToolUseFailure",
          is_interrupt: request.signal?.aborted ?? false,
          tool_input: toJsonObject(mergedInput),
          tool_name: request.toolName,
          tool_use_id: toolUseId,
        });
      } catch (hookError) {
        this.batch.finish(toolUseId, request.toolName, "failed");
        throw new AggregateError(
          [error, hookError],
          `Tool ${request.toolName} and its failure Hook both failed.`,
        );
      }

      this.batch.finish(toolUseId, request.toolName, "failed");
      throw error;
    }
  }

  private eventBase<TName extends "PostToolUse" | "PostToolUseFailure" | "PreToolUse">(
    hook_event_name: TName,
  ): HookEventBase<TName> {
    return {
      cwd: this.context.cwd,
      hook_event_name,
      permission_mode: this.context.permissionMode,
      session_id: this.context.sessionId,
      transcript_path: this.context.transcriptPath,
    };
  }
}

function toJsonObject(value: unknown): JsonObject {
  const normalized = toJsonValue(value);

  if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized as JsonObject;
  }

  return { value: normalized };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
