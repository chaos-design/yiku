export type PromptSegmentKind =
  | "history"
  | "instruction"
  | "reference"
  | "summary"
  | "user-request";

export type PromptSegmentSource =
  | "hook"
  | "memory"
  | "runtime"
  | "skill"
  | "tool"
  | "user"
  | "workspace";

export type PromptTrustLevel = "trusted" | "untrusted" | "user-authoritative";

export interface PromptSegment {
  readonly content: string;
  readonly digest?: string | undefined;
  readonly kind: PromptSegmentKind;
  readonly source: PromptSegmentSource;
  readonly sourceId?: string | undefined;
  readonly trust: PromptTrustLevel;
}

export type PromptRiskSeverity = "info" | "warning";

export interface PromptRiskFinding {
  readonly code:
    | "instruction-override"
    | "prompt-exfiltration"
    | "role-reassignment"
    | "tool-coercion";
  readonly segmentIndex: number;
  readonly severity: PromptRiskSeverity;
  readonly source: PromptSegmentSource;
  readonly sourceId?: string | undefined;
  readonly trust: PromptTrustLevel;
}
