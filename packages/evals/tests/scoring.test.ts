import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  createEvaluationScorecard,
  DEFAULT_DIMENSION_WEIGHTS,
  EvalPlanner,
  EvaluatorRegistry,
  gradeFor,
  MAX_EVAL_INPUT_BYTES,
  sha256Text,
  validateEvaluationScorecardDigest,
} from "../src/index.js";
import type {
  EvalCheckDefinition,
  EvalCheckEvaluator,
  EvalCheckResult,
  EvalExecutionContext,
  PlannedEvalCheck,
} from "../src/types.js";

describe("evaluation scoring", () => {
  it("weights dimensions, assigns grades, and includes missing execution as zero", () => {
    const plan = planned();
    const results = plan.checks.map((check) => result(check, check.id === "correctness" ? 0.5 : 1));
    const scorecard = createEvaluationScorecard(plan, context(), results, 25);

    expect(scorecard.dimensionScores).toEqual({
      correctness: 0.5,
      performance: 1,
      "resource-efficiency": 1,
      "safety-reliability": 1,
    });
    expect(scorecard.overallScore).toBe(0.75);
    expect(scorecard.grade).toBe("C");
    expect(scorecard.qualityPassed).toBe(false);
  });

  it("treats blockers and unknown receipts as non-compensable hard gates", () => {
    const plan = planned();
    const passing = plan.checks.map((check) => result(check, 1));
    const unknownReceipt = createEvaluationScorecard(
      plan,
      {
        ...context(),
        operationReceipts: [
          {
            artifactRefs: [],
            completedAt: "2026-08-13T00:00:00.000Z",
            operationId: "operation",
            result: "unknown",
          },
        ],
      },
      passing,
      1,
    );
    expect(unknownReceipt).toMatchObject({
      hardGatePassed: false,
      overallScore: 1,
      passed: false,
    });

    const blocker = plan.checks.map((check) =>
      check.id === "safety"
        ? {
            ...result(check, 0),
            passed: false,
            status: "failed" as const,
          }
        : result(check, 1),
    );
    expect(createEvaluationScorecard(plan, context(), blocker, 1).hardGatePassed).toBe(false);
  });

  it("uses a semantic digest that excludes timing noise", () => {
    const plan = planned();
    const firstResults = plan.checks.map((check) => result(check, 1, 1));
    const secondResults = plan.checks.map((check) => result(check, 1, 999));
    const first = createEvaluationScorecard(plan, context(), firstResults, 10);
    const second = createEvaluationScorecard(plan, context(), secondResults, 1_000);

    expect(first.digest).toBe(second.digest);
    expect(first.durationMs).not.toBe(second.durationMs);
  });

  it("defines exact grade boundaries", () => {
    expect(gradeFor(1)).toBe("S");
    expect(gradeFor(0.95)).toBe("S");
    expect(gradeFor(0.94)).toBe("A");
    expect(gradeFor(0.8)).toBe("B");
    expect(gradeFor(0.7)).toBe("C");
    expect(gradeFor(0.69)).toBe("D");
    expect(() => gradeFor(Number.NaN)).toThrow("between 0 and 1");
    expect(() => gradeFor(-1)).toThrow("between 0 and 1");
    expect(() => gradeFor(2)).toThrow("between 0 and 1");
  });

  it("rejects malformed result sets and non-finite scorecard durations", () => {
    const plan = planned();
    const results = plan.checks.map((check) => result(check, 1));
    for (const durationMs of [Number.NaN, -1]) {
      expect(() => createEvaluationScorecard(plan, context(), results, durationMs)).toThrow(
        "duration",
      );
    }
    expect(() =>
      createEvaluationScorecard(
        plan,
        context(),
        [{ ...results[0], id: "foreign" } as EvalCheckResult, ...results.slice(1)],
        1,
      ),
    ).toThrow("does not belong");
    expect(() =>
      createEvaluationScorecard(plan, context(), [results[0] as EvalCheckResult, ...results], 1),
    ).toThrow("Duplicate");
    expect(() => createEvaluationScorecard(plan, context(), results.slice(1), 1)).toThrow(
      "missing",
    );
  });

  it("scores every result state, zero-weight dimensions, and partial receipts deterministically", () => {
    const original = planned();
    const plan = {
      ...original,
      checks: original.checks.map((check) =>
        check.id === "resource" ? { ...check, weight: 0 } : check,
      ),
    };
    const results = plan.checks.map((check): EvalCheckResult => {
      const base = result(check, 1);
      if (check.id === "correctness") {
        const { score: _, ...withoutScore } = base;
        return { ...withoutScore, feedback: "Checked." };
      }
      if (check.id === "safety") {
        const { score: _, ...withoutScore } = base;
        return {
          ...withoutScore,
          errorCode: "EVAL_PROVIDER_UNAVAILABLE",
          passed: false,
          status: "error",
        };
      }
      if (check.id === "performance") {
        const { score: _, ...withoutScore } = base;
        return {
          ...withoutScore,
          errorCode: "EVAL_DEPENDENCY_FAILED",
          passed: false,
          status: "not-run",
        };
      }
      const { score: _, ...withoutScore } = base;
      return {
        ...withoutScore,
        passed: false,
        status: "failed",
      };
    });
    const scorecard = createEvaluationScorecard(
      plan,
      {
        ...context(),
        operationReceipts: [
          {
            artifactRefs: [],
            completedAt: "2026-08-13T00:00:00.000Z",
            operationId: "partial",
            result: "partial",
          },
        ],
      },
      results,
      1,
    );

    expect(scorecard.counts).toEqual({ error: 1, failed: 1, "not-run": 1, passed: 1 });
    expect(scorecard.dimensionScores["resource-efficiency"]).toBe(1);
    expect(scorecard.hardGatePassed).toBe(false);
    expect(() => validateEvaluationScorecardDigest(scorecard)).not.toThrow();
    expect(() => validateEvaluationScorecardDigest({ ...scorecard, overallScore: 0.5 })).toThrow(
      "digest",
    );
  });
});

function planned() {
  const checks = [
    check("correctness", "correctness"),
    check("safety", "safety-reliability"),
    check("performance", "performance"),
    check("resource", "resource-efficiency"),
  ];
  const evaluators = checks.map(evaluator);
  return new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry: new EvaluatorRegistry(evaluators),
  }).createPlan({
    profile: {
      checks,
      dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
      id: "profile",
      limits: {
        maxConcurrentChecks: 4,
        maxInputBytes: MAX_EVAL_INPUT_BYTES,
        maxRepairAttempts: 0,
        timeoutMs: 1_000,
      },
      mode: "enforce",
      qualityThreshold: 0.8,
      version: 1,
    },
    runId: "run",
    taskId: "task",
  });
}

function check(id: string, dimension: EvalCheckDefinition["dimension"]): EvalCheckDefinition {
  return {
    capability: `capability-${id}`,
    config: {},
    dependsOn: [],
    dimension,
    evaluator: `evaluator-${id}`,
    evidenceRequired: false,
    id,
    required: true,
    severity: dimension === "safety-reliability" ? "blocker" : "error",
    timeoutMs: 100,
    weight: 1,
  };
}

function evaluator(definition: EvalCheckDefinition): EvalCheckEvaluator {
  return {
    descriptor: {
      capability: definition.capability,
      deterministic: true,
      key: definition.evaluator,
      label: definition.id,
      version: "1.0.0",
    },
    evaluate(check) {
      return result(check, 1);
    },
  };
}

function result(check: PlannedEvalCheck, score: number, durationMs = 1): EvalCheckResult {
  const passed = score > 0;
  return {
    dimension: check.dimension,
    durationMs,
    evaluator: check.evaluator,
    evidenceRefs: [],
    id: check.id,
    label: check.id,
    passed,
    required: check.required,
    retryable: !passed,
    score,
    severity: check.severity,
    status: passed ? "passed" : "failed",
    summary: passed ? "Passed." : "Failed.",
    version: 1,
  };
}

function context(): EvalExecutionContext {
  const finalOutput = "done";
  return {
    artifacts: [],
    attemptId: "attempt",
    finalOutput,
    finalOutputDigest: sha256Text(finalOutput),
    flow: new AtomicFlowRun({ runId: "run" }).snapshot(),
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
}
