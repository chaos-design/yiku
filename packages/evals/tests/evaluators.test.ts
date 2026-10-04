import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  createDefaultEvalProfile,
  DEFAULT_CHECK_EVALUATORS,
  EvalPlanner,
  EvalScheduler,
  EvaluatorRegistry,
  FinalOutputCheckEvaluator,
  FlowIntegrityCheckEvaluator,
  FlowIntegrityEvaluator,
  MemorySafetyCheckEvaluator,
  PerformanceBudgetEvaluator,
  ResourceBudgetEvaluator,
  sha256Text,
} from "../src/index.js";
import type { EvalExecutionContext, PlannedEvalCheck } from "../src/types.js";

describe("industrial default evaluators", () => {
  it("accepts complete, safe runs within performance and resource budgets", async () => {
    const scorecard = await run(context());

    expect(scorecard).toMatchObject({
      grade: "S",
      hardGatePassed: true,
      passed: true,
    });
    expect(scorecard.results.map((result) => result.id)).toEqual([
      "flow-integrity",
      "final-output",
      "memory-safety",
      "performance-budget",
      "resource-budget",
    ]);
  });

  it("reports missing runtime metrics as explicit not-run results", async () => {
    const scorecard = await run({
      ...context(),
      runtimeMetrics: undefined,
    });

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EVAL_EVIDENCE_MISSING",
          id: "performance-budget",
          status: "not-run",
        }),
        expect.objectContaining({
          errorCode: "EVAL_EVIDENCE_MISSING",
          id: "resource-budget",
          status: "not-run",
        }),
      ]),
    );
    expect(scorecard.passed).toBe(false);
  });

  it("fails limits and treats secret findings as a blocker", async () => {
    const flow = completeFlow(true);
    const scorecard = await run({
      ...context(),
      flow: flow.snapshot(),
      runtimeMetrics: {
        durationMs: 900_000,
        peakRssBytes: 384 * 1024 * 1024,
      },
    });

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "memory-safety", status: "failed" }),
        expect.objectContaining({ id: "performance-budget", status: "failed" }),
        expect.objectContaining({ id: "resource-budget", status: "failed" }),
      ]),
    );
    expect(scorecard.hardGatePassed).toBe(false);
    expect(scorecard.passed).toBe(false);
  });

  it("scores values between targets and limits and accepts every profile override", async () => {
    const scorecard = await run({
      ...context(),
      runtimeMetrics: {
        cpuMs: 20,
        durationMs: 750_000,
        peakRssBytes: 320 * 1024 * 1024,
      },
    });
    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "performance-budget", score: 0.5 }),
        expect.objectContaining({ id: "resource-budget", score: 0.5 }),
      ]),
    );
    expect(
      createDefaultEvalProfile({
        id: "custom",
        maxConcurrentChecks: 2,
        maxInputBytes: 1024,
        maxRepairAttempts: 0,
        mode: "enforce",
        qualityThreshold: 0.9,
        timeoutMs: 2_000,
      }),
    ).toMatchObject({
      id: "custom",
      limits: {
        maxConcurrentChecks: 2,
        maxInputBytes: 1024,
        maxRepairAttempts: 0,
        timeoutMs: 2_000,
      },
      mode: "enforce",
      qualityThreshold: 0.9,
    });
  });

  it("rejects invalid runtime metrics and budget configuration", () => {
    const base = budgetCheck();
    for (const value of [Number.NaN, -1]) {
      expect(() =>
        new PerformanceBudgetEvaluator().evaluate(base, {
          ...context(),
          runtimeMetrics: { durationMs: value },
        }),
      ).toThrow("non-negative");
    }
    for (const config of [
      { limit: 1, target: 2 },
      { limit: "invalid", target: 1 },
      { limit: 2, target: Number.NaN },
      { limit: 2, target: -1 },
    ]) {
      expect(() =>
        new ResourceBudgetEvaluator().evaluate(
          {
            ...base,
            config,
            dimension: "resource-efficiency",
            evaluator: "resource-budget",
            id: "resource-budget",
          },
          {
            ...context(),
            runtimeMetrics: { peakRssBytes: 1 },
          },
        ),
      ).toThrow();
    }
  });

  it("reports non-monotonic flows and accepts error or skipped closure phases", () => {
    const snapshot = completeFlow().snapshot();
    const [start, end] = snapshot.events;
    if (start === undefined || end === undefined) {
      throw new Error("Expected complete Flow events.");
    }
    const evaluator = new FlowIntegrityEvaluator();
    expect(
      evaluator.evaluate({
        finalOutput: "done",
        flow: {
          ...snapshot,
          events: [end, start],
        },
      }),
    ).toMatchObject({
      passed: false,
      summary: expect.stringContaining("non-monotonic"),
    });
    for (const phase of ["error", "skipped"] as const) {
      expect(
        evaluator.evaluate({
          finalOutput: "done",
          flow: {
            ...snapshot,
            events: [start, { ...end, phase }],
          },
        }),
      ).toMatchObject({ passed: true });
    }
  });

  it("supports direct check evaluation without an AbortSignal", () => {
    const execution = context();
    const base = budgetCheck();
    expect(
      new FlowIntegrityCheckEvaluator().evaluate(
        {
          ...base,
          evaluator: "flow-integrity-v2",
          id: "flow-integrity",
        },
        execution,
      ),
    ).toMatchObject({ status: "passed" });
    expect(
      new FinalOutputCheckEvaluator().evaluate(
        {
          ...base,
          evaluator: "final-output-v2",
          id: "final-output",
        },
        execution,
      ),
    ).toMatchObject({ status: "passed" });
    expect(
      new MemorySafetyCheckEvaluator().evaluate(
        {
          ...base,
          evaluator: "memory-safety-v2",
          id: "memory-safety",
        },
        execution,
      ),
    ).toMatchObject({ status: "passed" });
  });
});

async function run(contextValue: EvalExecutionContext) {
  const registry = new EvaluatorRegistry(DEFAULT_CHECK_EVALUATORS);
  const plan = new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  }).createPlan({
    profile: createDefaultEvalProfile({
      maxRepairAttempts: 0,
      mode: "enforce",
      timeoutMs: 1_000,
    }),
    runId: "run",
    taskId: "task",
  });
  return new EvalScheduler({ registry }).run(plan, contextValue);
}

function context(): EvalExecutionContext {
  const output = "done";
  return {
    artifacts: [],
    attemptId: "attempt",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow: completeFlow().snapshot(),
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    runtimeMetrics: {
      cpuMs: 10,
      durationMs: 100,
      peakRssBytes: 1024,
    },
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
}

function completeFlow(secret = false): AtomicFlowRun {
  const flow = new AtomicFlowRun({ runId: "run" });
  const root = flow.start({
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    instanceId: "run-instance",
  });
  root.end();
  if (secret) {
    const memory = flow.start({
      atom: {
        key: "memory.write",
        kind: "memory",
        label: "Memory Write",
        level: "runtime",
      },
      payload: {
        summary: "Bearer secret-value-123456",
      },
    });
    memory.end();
  }
  return flow;
}

function budgetCheck(): PlannedEvalCheck {
  return {
    capability: "performance-budget",
    config: {
      limit: 2,
      target: 1,
    },
    dependsOn: [],
    dimension: "performance",
    evaluator: "performance-budget",
    evidenceRequired: true,
    id: "performance-budget",
    ordinal: 0,
    required: true,
    severity: "warning",
    source: "project",
    timeoutMs: 1_000,
    weight: 1,
  };
}
