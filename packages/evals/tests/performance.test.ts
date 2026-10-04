import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIMENSION_WEIGHTS,
  EvalPlanner,
  EvalScheduler,
  EvaluatorRegistry,
  MAX_EVAL_INPUT_BYTES,
  sha256Text,
} from "../src/index.js";
import type {
  EvalCheckDefinition,
  EvalCheckEvaluator,
  EvalCheckResult,
  EvalExecutionContext,
  EvalProfile,
  PlannedEvalCheck,
} from "../src/types.js";

describe("evaluation concurrency and repeatability", () => {
  it("bounds 12 queued runs to 8 active runs with 32 checks each", async () => {
    const activeRuns = new Map<string, number>();
    let maximumActiveRuns = 0;
    let maximumChecks = 0;
    const evaluator = syntheticEvaluator(async (check, context) => {
      activeRuns.set(context.runId, (activeRuns.get(context.runId) ?? 0) + 1);
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns.size);
      maximumChecks = Math.max(
        maximumChecks,
        [...activeRuns.values()].reduce((total, count) => total + count, 0),
      );
      await delay(3);
      const remaining = (activeRuns.get(context.runId) ?? 1) - 1;
      if (remaining === 0) {
        activeRuns.delete(context.runId);
      } else {
        activeRuns.set(context.runId, remaining);
      }
      return passed(check);
    });
    const registry = new EvaluatorRegistry([evaluator]);
    const scheduler = new EvalScheduler({
      maxConcurrentRuns: 8,
      registry,
    });
    const planner = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    });

    const scorecards = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const runId = `run-${index}`;
        return scheduler.run(
          planner.createPlan({
            profile: profile(),
            runId,
            taskId: `task-${index}`,
          }),
          context(runId, `task-${index}`, `attempt-${index}`),
        );
      }),
    );

    expect(scorecards.every((scorecard) => scorecard.passed)).toBe(true);
    expect(maximumActiveRuns).toBe(8);
    expect(maximumChecks).toBeLessThanOrEqual(8 * 4);
    expect(activeRuns.size).toBe(0);
  });

  it("replays deterministic fixtures 20 times with the same semantic digest", async () => {
    const evaluator = syntheticEvaluator((check) => passed(check));
    const registry = new EvaluatorRegistry([evaluator]);
    const scheduler = new EvalScheduler({ registry });
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      profile: profile(),
      runId: "deterministic-run",
      taskId: "deterministic-task",
    });
    const input = context("deterministic-run", "deterministic-task", "deterministic-attempt");
    const scorecards = [];
    for (let index = 0; index < 20; index += 1) {
      scorecards.push(await scheduler.run(plan, input));
    }

    expect(new Set(scorecards.map((scorecard) => scorecard.digest)).size).toBe(1);
    expect(new Set(scorecards.map((scorecard) => scorecard.passed))).toEqual(new Set([true]));
  });

  it("keeps warmed 32-check scheduler p95 below the 100ms target", async () => {
    const evaluator = syntheticEvaluator((check) => passed(check));
    const registry = new EvaluatorRegistry([evaluator]);
    const scheduler = new EvalScheduler({ registry });
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      profile: profile(),
      runId: "performance-run",
      taskId: "performance-task",
    });
    const input = context("performance-run", "performance-task", "performance-attempt");
    for (let index = 0; index < 5; index += 1) {
      await scheduler.run(plan, input);
    }
    const samples: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      await scheduler.run(plan, input);
      samples.push(performance.now() - started);
    }

    expect(percentile(samples, 0.95)).toBeLessThan(100);
  });
});

function profile(): EvalProfile {
  const dimensions = [
    "correctness",
    "safety-reliability",
    "performance",
    "resource-efficiency",
  ] as const;
  const checks: EvalCheckDefinition[] = Array.from({ length: 32 }, (_, index) => ({
    capability: "synthetic",
    config: {},
    dependsOn: [],
    dimension: dimensions[index % dimensions.length] ?? "correctness",
    evaluator: "synthetic",
    evidenceRequired: false,
    id: `check-${index}`,
    required: true,
    severity: "error",
    timeoutMs: 1_000,
    weight: 1,
  }));
  return {
    checks,
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: "performance",
    limits: {
      maxConcurrentChecks: 4,
      maxInputBytes: MAX_EVAL_INPUT_BYTES,
      maxRepairAttempts: 0,
      timeoutMs: 5_000,
    },
    mode: "enforce",
    qualityThreshold: 0.8,
    version: 1,
  };
}

function syntheticEvaluator(
  evaluate: (
    check: PlannedEvalCheck,
    context: EvalExecutionContext,
  ) => Promise<EvalCheckResult> | EvalCheckResult,
): EvalCheckEvaluator {
  return {
    descriptor: {
      capability: "synthetic",
      deterministic: true,
      key: "synthetic",
      label: "Synthetic",
      version: "1.0.0",
    },
    evaluate,
  };
}

function context(runId: string, taskId: string, attemptId: string): EvalExecutionContext {
  const finalOutput = "done";
  return {
    artifacts: [],
    attemptId,
    finalOutput,
    finalOutputDigest: sha256Text(finalOutput),
    flow: {
      degraded: false,
      degradationCodes: [],
      events: [],
      runId,
    },
    flowRef: `flow:${runId}`,
    operationReceipts: [],
    runId,
    taskId,
    taskSnapshotRef: `task:${taskId}`,
  };
}

function passed(check: PlannedEvalCheck): EvalCheckResult {
  return {
    dimension: check.dimension,
    durationMs: 0,
    evaluator: check.evaluator,
    evidenceRefs: [],
    id: check.id,
    label: check.id,
    passed: true,
    required: check.required,
    retryable: false,
    score: 1,
    severity: check.severity,
    status: "passed",
    summary: "Passed.",
    version: 1,
  };
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
