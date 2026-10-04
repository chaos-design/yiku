export const PERMISSION_DECISIONS = ["allow", "deny"] as const;
export const PERMISSION_ASSESSMENTS = ["allow", "ask", "deny"] as const;
export const PERMISSION_RISKS = ["low", "medium", "high"] as const;

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];
export type PermissionAssessment = (typeof PERMISSION_ASSESSMENTS)[number];
export type PermissionRisk = (typeof PERMISSION_RISKS)[number];

export interface PermissionRequest {
  readonly capabilities: readonly string[];
  readonly normalizedAction: string;
  readonly policyId: string;
  readonly workspaceId: string;
  readonly action: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly reason: string;
  readonly risk: PermissionRisk;
  readonly subject: string;
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
}

export interface PermissionResponse {
  readonly decision: PermissionDecision;
  readonly reason?: string | undefined;
  readonly scope?: "once" | "persistent" | "session" | undefined;
}

export type PermissionApprovalHandler = (
  request: PermissionRequest,
) => PermissionResponse | Promise<PermissionResponse>;

export type PermissionAssessmentHandler = (
  request: PermissionRequest,
  assessment: PermissionAssessment,
) => PermissionAssessment | Promise<PermissionAssessment>;

export interface PermissionApprovalOptions {
  readonly approvalHandler?: PermissionApprovalHandler | undefined;
  readonly assessment?: PermissionAssessment | undefined;
  readonly assessmentHandler?: PermissionAssessmentHandler | undefined;
  readonly defaultDecision?: PermissionDecision | undefined;
}
