import type { PermissionApprovalOptions } from "./types.js";
import {
  PERMISSION_ASSESSMENTS,
  PERMISSION_DECISIONS,
  type PermissionAssessment,
  type PermissionRequest,
  type PermissionResponse,
} from "./types.js";

export class PermissionDeniedError extends Error {
  public override readonly name = "PermissionDeniedError";

  public constructor(
    public readonly request: PermissionRequest,
    public readonly response: PermissionResponse,
  ) {
    super(formatPermissionDeniedMessage(request, response));
  }
}

export async function requestPermissionApproval(
  request: PermissionRequest,
  options: PermissionApprovalOptions = {},
): Promise<PermissionResponse> {
  const runtimeAssessment = options.assessment ?? "ask";

  if (runtimeAssessment === "deny") {
    throw new PermissionDeniedError(request, {
      decision: "deny",
      reason: "Denied by runtime permission policy.",
    });
  }

  const assessment =
    options.assessmentHandler === undefined
      ? runtimeAssessment
      : normalizePermissionAssessment(await options.assessmentHandler(request, runtimeAssessment));

  if (assessment === "allow") {
    return {
      decision: "allow",
      reason:
        options.assessmentHandler === undefined
          ? "Allowed by runtime permission policy."
          : "Allowed by configured permission policy.",
    };
  }

  if (assessment === "deny") {
    throw new PermissionDeniedError(request, {
      decision: "deny",
      reason: "Denied by configured permission policy.",
    });
  }

  const response = normalizePermissionResponse(
    options.approvalHandler
      ? await options.approvalHandler(request)
      : {
          decision: options.defaultDecision ?? "deny",
          reason: "No permission approval handler configured.",
        },
  );

  if (response.decision === "allow") {
    return response;
  }

  throw new PermissionDeniedError(request, response);
}

export function isPermissionDecision(value: string): boolean {
  return PERMISSION_DECISIONS.some((decision) => decision === value);
}

function normalizePermissionAssessment(assessment: PermissionAssessment): PermissionAssessment {
  if (!PERMISSION_ASSESSMENTS.includes(assessment)) {
    throw new Error(`Invalid permission assessment: ${String(assessment)}.`);
  }
  return assessment;
}

function normalizePermissionResponse(response: PermissionResponse): PermissionResponse {
  if (!isPermissionDecision(response.decision)) {
    throw new Error(`Invalid permission decision: ${String(response.decision)}.`);
  }

  const reason = response.reason?.trim();
  if (
    response.scope !== undefined &&
    response.scope !== "once" &&
    response.scope !== "persistent" &&
    response.scope !== "session"
  ) {
    throw new Error(`Invalid permission scope: ${String(response.scope)}.`);
  }

  return {
    decision: response.decision,
    ...(reason ? { reason } : {}),
    ...(response.scope !== undefined ? { scope: response.scope } : {}),
  };
}

function formatPermissionDeniedMessage(
  request: PermissionRequest,
  response: PermissionResponse,
): string {
  const reason = response.reason ?? request.reason;

  return `Permission denied for ${request.toolName} ${request.action}: ${reason}`;
}
