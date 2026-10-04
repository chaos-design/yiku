import { randomUUID } from "node:crypto";
import type {
  PermissionApprovalHandler,
  PermissionRequest,
  PermissionResponse,
} from "@yiku/agent-code";
import type { HookEventBase, HookPermissionMode, HookSession, JsonObject } from "@yiku/hooks";

export interface PermissionHookContext {
  readonly cwd: string;
  readonly hookSession: HookSession;
  readonly permissionMode: HookPermissionMode;
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export interface HookPermissionApprovalOptions {
  readonly context: PermissionHookContext;
  readonly forceHumanApproval?: boolean | undefined;
  readonly userApprovalHandler?: PermissionApprovalHandler | undefined;
}

export class HookPermissionApproval {
  public constructor(private readonly options: HookPermissionApprovalOptions) {}

  public readonly handle: PermissionApprovalHandler = async (request) => {
    const toolUseId = request.toolCallId ?? randomUUID();
    const toolInput = permissionInput(request);
    const decision = await this.options.context.hookSession.dispatch({
      ...this.eventBase("PermissionRequest"),
      hook_event_name: "PermissionRequest",
      tool_input: toolInput,
      tool_name: request.toolName,
      tool_use_id: toolUseId,
    });

    if (decision.action === "block" || decision.action === "stop") {
      const response = {
        decision: "deny",
        reason: decision.reasons.join("; ") || "Permission denied by Hook.",
      } satisfies PermissionResponse;
      await this.emitDenied(request, toolUseId, toolInput, response.reason);
      return response;
    }

    if (decision.action === "allow" && this.options.forceHumanApproval !== true) {
      return {
        decision: "allow",
        reason: decision.reasons.join("; ") || "Permission approved by Hook.",
      };
    }

    const response =
      this.options.userApprovalHandler === undefined
        ? {
            decision: "deny" as const,
            reason: "No permission approval handler configured.",
          }
        : await this.options.userApprovalHandler(request);

    if (response.decision === "deny") {
      await this.emitDenied(request, toolUseId, toolInput, response.reason ?? request.reason);
    }

    return response;
  };

  private async emitDenied(
    request: PermissionRequest,
    toolUseId: string,
    toolInput: JsonObject,
    denialReason: string,
  ): Promise<void> {
    await this.options.context.hookSession.dispatch({
      ...this.eventBase("PermissionDenied"),
      denial_reason: denialReason,
      hook_event_name: "PermissionDenied",
      tool_input: toolInput,
      tool_name: request.toolName,
      tool_use_id: toolUseId,
    });
  }

  private eventBase<TName extends "PermissionDenied" | "PermissionRequest">(
    hook_event_name: TName,
  ): HookEventBase<TName> {
    return {
      cwd: this.options.context.cwd,
      hook_event_name,
      permission_mode: this.options.context.permissionMode,
      session_id: this.options.context.sessionId,
      transcript_path: this.options.context.transcriptPath,
    };
  }
}

function permissionInput(request: PermissionRequest): JsonObject {
  return {
    action: request.action,
    capabilities: [...request.capabilities],
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    normalizedAction: request.normalizedAction,
    policyId: request.policyId,
    reason: request.reason,
    risk: request.risk,
    subject: request.subject,
    workspaceId: request.workspaceId,
  };
}
