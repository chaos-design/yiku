import type { RuntimeBudgetConfig } from "../config/types.js";
import type { AgentContinuationState, AgentStopReason } from "../runtime/types.js";
import { parseSessionState, type SessionState } from "./session-state.js";

export interface FinishStageInput {
  readonly progressRevisionAtStart: number;
  readonly stopReason: AgentStopReason;
}

export type ExecutionPolicyDecision =
  | {
      readonly action: "complete" | "continue" | "fail";
      readonly state: SessionState;
    }
  | {
      readonly action: "pause";
      readonly reason:
        | "auto-continue-disabled"
        | "blocked-task"
        | "cancelled"
        | "memory-error"
        | "needs-review"
        | "no-progress"
        | "stage-budget"
        | "timeout";
      readonly state: SessionState;
    };

export class AgentStageStopError extends Error {
  public override readonly name = "AgentStageStopError";
  public readonly continuationState?: AgentContinuationState | undefined;
  public readonly stopReason: Exclude<AgentStopReason, "completed" | "provider_error">;

  public constructor(input: {
    readonly continuationState?: AgentContinuationState | undefined;
    readonly stopReason: Exclude<AgentStopReason, "completed" | "provider_error">;
  }) {
    super(`Agent stage stopped: ${input.stopReason}.`);
    this.continuationState = input.continuationState;
    this.stopReason = input.stopReason;
  }
}

export class SessionPausedError extends Error {
  public override readonly name = "SessionPausedError";

  public constructor(
    public readonly reason: Extract<ExecutionPolicyDecision, { action: "pause" }>["reason"],
    public readonly state: SessionState,
  ) {
    super(`Session paused: ${reason}.`);
  }
}

export class StageTimeoutError extends Error {
  public override readonly name = "StageTimeoutError";
}

export class ExecutionPolicy {
  public constructor(private readonly budget: RuntimeBudgetConfig) {}

  public config(): RuntimeBudgetConfig {
    return this.budget;
  }

  public startStage(state: SessionState): SessionState {
    return parseSessionState({
      ...state,
      budget: {
        ...state.budget,
        stage: state.budget.stage + 1,
        toolCalls: 0,
        totalStages: state.budget.totalStages + 1,
      },
      status: "active",
    });
  }

  public finishStage(state: SessionState, input: FinishStageInput): ExecutionPolicyDecision {
    const noProgressStages =
      state.budget.progressRevision > input.progressRevisionAtStart
        ? 0
        : state.budget.noProgressStages + 1;
    const updated = parseSessionState({
      ...state,
      budget: {
        ...state.budget,
        noProgressStages,
      },
    });

    switch (input.stopReason) {
      case "completed":
        return {
          action: "complete",
          state: parseSessionState({ ...updated, status: "completed" }),
        };
      case "cancelled":
        return this.pause(updated, "cancelled");
      case "provider_error":
        return {
          action: "fail",
          state: parseSessionState({ ...updated, status: "failed" }),
        };
      case "max_turns":
      case "timeout":
        return this.afterBoundedStop(updated, input.stopReason);
    }
  }

  public startEpoch(state: SessionState): SessionState {
    return parseSessionState({
      ...state,
      budget: {
        ...state.budget,
        epoch: state.budget.epoch + 1,
        noProgressStages: 0,
        stage: 0,
        toolCalls: 0,
      },
      status: "active",
    });
  }

  private afterBoundedStop(
    state: SessionState,
    stopReason: "max_turns" | "timeout",
  ): ExecutionPolicyDecision {
    if (!this.budget.autoContinue) {
      return this.pause(state, "auto-continue-disabled");
    }
    if (state.budget.stage >= this.budget.maxStagesPerEpoch) {
      return this.pause(state, "stage-budget");
    }
    if (state.budget.noProgressStages >= this.budget.maxNoProgressStages) {
      return this.pause(state, "no-progress");
    }
    if (stopReason === "timeout") {
      return this.pause(state, "timeout");
    }
    return {
      action: "continue",
      state,
    };
  }

  public pause(
    state: SessionState,
    reason: Extract<ExecutionPolicyDecision, { action: "pause" }>["reason"],
  ): ExecutionPolicyDecision {
    return {
      action: "pause",
      reason,
      state: parseSessionState({ ...state, status: "paused" }),
    };
  }
}
