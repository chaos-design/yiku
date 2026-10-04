import type { AgentProgressEvent, AgentUsage, EvaluationOutcome } from "@yiku/agent-orchestrator";
import type {
  CliJsonResult,
  CliMachineOutputFailure,
  CliMachineOutputSuccess,
  CliMachineStatus,
  CliVerificationSummary,
} from "./types.js";

export class MachineOutputState {
  private sessionId?: string | undefined;
  private usage?: AgentUsage | undefined;
  private verification?: CliVerificationSummary | undefined;

  public observe(event: AgentProgressEvent): void {
    this.captureSessionId(event);
    if (event.type === "usage_updated") {
      this.usage = addUsage(this.usage, event.usage);
    }
    if (event.type === "evaluation_finished") {
      const { type: _type, ...verification } = event;
      this.verification = verification;
    }
  }

  public failure(input: CliMachineOutputFailure): CliJsonResult {
    return {
      ...(input.diagnostics.length === 0 ? {} : { diagnostics: input.diagnostics }),
      error: input.error,
      ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      status: input.status,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.verification === undefined ? {} : { verification: this.verification }),
    };
  }

  public success(input: CliMachineOutputSuccess): CliJsonResult {
    return {
      ...(input.diagnostics.length === 0 ? {} : { diagnostics: input.diagnostics }),
      ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
      output: input.output,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      status: machineStatusForEvaluation(input.evaluation),
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.verification === undefined ? {} : { verification: this.verification }),
    };
  }

  private captureSessionId(event: AgentProgressEvent): void {
    switch (event.type) {
      case "session_cancelled":
      case "session_failed":
      case "session_finished":
      case "session_resumed":
      case "session_started":
        this.sessionId = event.sessionId;
        return;
      default:
        return;
    }
  }
}

export function machineStatusForEvaluation(
  evaluation: EvaluationOutcome | undefined,
): CliMachineStatus {
  switch (evaluation?.decision.action) {
    case "needs-review":
    case "retry":
      return "needs-review";
    case "rejected":
      return "failed";
    case "accepted":
    case "degraded":
    case undefined:
      return "completed";
  }
}

export function stringifyMachineValue(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (current instanceof Error) {
        return {
          message: current.message,
          name: current.name,
        };
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }
      return current;
    }) ?? "null"
  );
}

function addUsage(current: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (current === undefined) {
    return { ...next };
  }
  return {
    cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    peakInputTokens: Math.max(current.peakInputTokens, next.peakInputTokens),
    totalTokens: current.totalTokens + next.totalTokens,
  };
}
