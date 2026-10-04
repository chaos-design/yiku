import type { AgentProgressEvent, AgentUsage, EvaluationOutcome } from "@yiku/agent-orchestrator";

export const CLI_EXIT_CODES = Object.freeze({
  APPROVAL_REQUIRED: 5,
  BUDGET_PAUSED: 7,
  EXECUTION_FAILED: 1,
  EXTERNAL_DEPENDENCY_FAILED: 9,
  INVALID_ARGUMENT: 2,
  NEEDS_INPUT: 5,
  NEEDS_REVIEW: 6,
  POLICY_DENIED: 4,
  SUCCESS: 0,
  VERIFICATION_FAILED: 8,
  WORKSPACE_UNAUTHORIZED: 3,
} as const);

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export type CliOutputFormat = "json" | "ndjson" | "text";

export type CliMachineStatus = "completed" | "failed" | "needs-input" | "needs-review" | "paused";

export interface CliMachineDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface CliMachineError {
  readonly capability?: string | undefined;
  readonly code: string;
  readonly message: string;
  readonly questionKey?: string | undefined;
}

export type CliVerificationSummary = Omit<
  Extract<AgentProgressEvent, { readonly type: "evaluation_finished" }>,
  "type"
>;

export interface CliJsonResult {
  readonly diagnostics?: readonly CliMachineDiagnostic[] | undefined;
  readonly error?: CliMachineError | undefined;
  readonly evaluation?: EvaluationOutcome | undefined;
  readonly output?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly status: CliMachineStatus;
  readonly usage?: AgentUsage | undefined;
  readonly verification?: CliVerificationSummary | undefined;
}

export interface CliMachineOutputSuccess {
  readonly diagnostics: readonly CliMachineDiagnostic[];
  readonly evaluation?: EvaluationOutcome | undefined;
  readonly output: string;
}

export interface CliMachineOutputFailure {
  readonly diagnostics: readonly CliMachineDiagnostic[];
  readonly error: CliMachineError;
  readonly evaluation?: EvaluationOutcome | undefined;
  readonly status: Exclude<CliMachineStatus, "completed">;
}

export type CliNdjsonProgressEventType =
  | "agent.handoff"
  | "agent.updated"
  | "agent-profile.changed"
  | "checkpoint.saved"
  | "context.compacted"
  | "memory.operation"
  | "message.delta"
  | "prompt.risk-detected"
  | "question.cancelled"
  | "question.requested"
  | "question.resolved"
  | "reasoning.updated"
  | "runtime-boundary.changed"
  | "session.resumed"
  | "session.started"
  | "skill.activated"
  | "skill.resolved"
  | "skill-worker.finished"
  | "skill-worker.started"
  | "stage.finished"
  | "stage.started"
  | "subagent.finished"
  | "subagent.output"
  | "subagent.started"
  | "task.snapshot"
  | "tool.completed"
  | "tool.started"
  | "usage.updated"
  | "verification.completed";

export type CliNdjsonEvent =
  | {
      readonly event: AgentProgressEvent;
      readonly type: CliNdjsonProgressEventType;
    }
  | (CliJsonResult & {
      readonly type: "session.completed" | "session.failed";
    });

export interface CliMachineOutputWriter {
  observe(event: AgentProgressEvent): void;
  writeFailure(input: CliMachineOutputFailure): CliJsonResult;
  writeSuccess(input: CliMachineOutputSuccess): CliJsonResult;
}
