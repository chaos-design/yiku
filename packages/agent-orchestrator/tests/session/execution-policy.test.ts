import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_BUDGET_CONFIG } from "../../src/config/runtime-config.js";
import { ExecutionPolicy } from "../../src/session/execution-policy.js";
import { createInitialSessionState } from "../../src/session/session-state.js";

describe("ExecutionPolicy", () => {
  it("starts stages and continues max-turn runs within budget", () => {
    const policy = new ExecutionPolicy(DEFAULT_RUNTIME_BUDGET_CONFIG);
    const initial = state();
    const started = policy.startStage(initial);
    const decision = policy.finishStage(started, {
      progressRevisionAtStart: initial.budget.progressRevision,
      stopReason: "max_turns",
    });

    expect(started.budget).toMatchObject({
      stage: 1,
      toolCalls: 0,
      totalStages: 1,
    });
    expect(decision.action).toBe("continue");
    expect(decision.state.budget.noProgressStages).toBe(1);
  });

  it("completes successful stages and pauses cancellations", () => {
    const policy = new ExecutionPolicy(DEFAULT_RUNTIME_BUDGET_CONFIG);
    const started = policy.startStage(state());

    expect(
      policy.finishStage(started, {
        progressRevisionAtStart: 0,
        stopReason: "completed",
      }),
    ).toMatchObject({
      action: "complete",
      state: { status: "completed" },
    });
    expect(
      policy.finishStage(started, {
        progressRevisionAtStart: 0,
        stopReason: "cancelled",
      }),
    ).toMatchObject({
      action: "pause",
      reason: "cancelled",
      state: { status: "paused" },
    });
  });

  it("pauses at stage and no-progress limits", () => {
    const stagePolicy = new ExecutionPolicy({
      ...DEFAULT_RUNTIME_BUDGET_CONFIG,
      maxStagesPerEpoch: 1,
    });
    const stageDecision = stagePolicy.finishStage(stagePolicy.startStage(state()), {
      progressRevisionAtStart: 0,
      stopReason: "max_turns",
    });
    expect(stageDecision).toMatchObject({
      action: "pause",
      reason: "stage-budget",
    });

    const noProgressPolicy = new ExecutionPolicy({
      ...DEFAULT_RUNTIME_BUDGET_CONFIG,
      maxNoProgressStages: 1,
    });
    const noProgressDecision = noProgressPolicy.finishStage(noProgressPolicy.startStage(state()), {
      progressRevisionAtStart: 0,
      stopReason: "timeout",
    });
    expect(noProgressDecision).toMatchObject({
      action: "pause",
      reason: "no-progress",
    });
  });

  it("resets no-progress after durable progress and starts a new epoch", () => {
    const policy = new ExecutionPolicy(DEFAULT_RUNTIME_BUDGET_CONFIG);
    const started = policy.startStage({
      ...state(),
      budget: {
        ...state().budget,
        noProgressStages: 2,
        progressRevision: 3,
      },
    });
    const decision = policy.finishStage(started, {
      progressRevisionAtStart: 2,
      stopReason: "max_turns",
    });
    const resumed = policy.startEpoch(decision.state);

    expect(decision.state.budget.noProgressStages).toBe(0);
    expect(resumed.budget).toMatchObject({
      epoch: 2,
      noProgressStages: 0,
      stage: 0,
      toolCalls: 0,
    });
  });

  it("handles disabled continuation, timeout, and provider failures", () => {
    const disabled = new ExecutionPolicy({
      ...DEFAULT_RUNTIME_BUDGET_CONFIG,
      autoContinue: false,
    });
    expect(
      disabled.finishStage(disabled.startStage(state()), {
        progressRevisionAtStart: 0,
        stopReason: "max_turns",
      }),
    ).toMatchObject({
      action: "pause",
      reason: "auto-continue-disabled",
    });

    const timeoutState = {
      ...state(),
      budget: {
        ...state().budget,
        progressRevision: 1,
      },
    };
    expect(
      new ExecutionPolicy(DEFAULT_RUNTIME_BUDGET_CONFIG).finishStage(
        new ExecutionPolicy(DEFAULT_RUNTIME_BUDGET_CONFIG).startStage(timeoutState),
        {
          progressRevisionAtStart: 0,
          stopReason: "timeout",
        },
      ),
    ).toMatchObject({
      action: "pause",
      reason: "timeout",
    });
    expect(
      disabled.finishStage(disabled.startStage(state()), {
        progressRevisionAtStart: 0,
        stopReason: "provider_error",
      }),
    ).toMatchObject({
      action: "fail",
      state: { status: "failed" },
    });
  });
});

function state() {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "config-v1",
    modelKey: "default",
    now: "2026-08-01T00:00:00.000Z",
    sessionId: "session-1",
    workspaceDir: "/workspace",
  });
}
