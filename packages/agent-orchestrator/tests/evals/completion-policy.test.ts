import type { EvalCheckResult, EvaluationScorecard } from "@yiku/evals";
import { describe, expect, it } from "vitest";
import { CompletionPolicy } from "../../src/evals/completion-policy.js";

describe("CompletionPolicy", () => {
  const policy = new CompletionPolicy();

  it("prioritizes unknown side effects over scores and repair", () => {
    const decision = policy.decide({
      ...input(),
      operationReceipts: [
        {
          artifactRefs: [],
          completedAt: "2026-08-13T00:00:00.000Z",
          operationId: "operation",
          result: "unknown",
        },
      ],
    });
    expect(decision.action).toBe("needs-review");
  });

  it("retries retryable blockers once and rejects after exhaustion", () => {
    const blocker = result({
      id: "blocker",
      passed: false,
      retryable: true,
      severity: "blocker",
      status: "failed",
    });
    const first = policy.decide({
      ...input([blocker]),
      canRepair: true,
      maxRepairAttempts: 1,
    });
    const exhausted = policy.decide({
      ...input([blocker]),
      canRepair: true,
      maxRepairAttempts: 1,
      repairAttemptsUsed: 1,
    });

    expect(first).toMatchObject({
      action: "retry",
      repairInstruction: {
        failedCheckIds: ["blocker"],
      },
    });
    expect(exhausted.action).toBe("rejected");
    expect(exhausted.reasons).toContain("Automatic repair budget is exhausted.");
  });

  it("sends required errors and not-run checks to review", () => {
    for (const status of ["error", "not-run"] as const) {
      const decision = policy.decide({
        ...input([
          result({
            errorCode: status === "error" ? "EVAL_TIMEOUT" : "EVAL_DEPENDENCY_FAILED",
            passed: false,
            status,
          }),
        ]),
        canRepair: true,
      });
      expect(decision.action).toBe("needs-review");
    }
  });

  it("rejects non-retryable required failures and low quality", () => {
    expect(
      policy.decide(
        input([
          result({
            passed: false,
            status: "failed",
          }),
        ]),
      ).action,
    ).toBe("rejected");
    expect(
      policy.decide({
        ...input(),
        scorecard: {
          ...scorecard(),
          overallScore: 0.5,
          passed: false,
          qualityPassed: false,
        },
      }).action,
    ).toBe("rejected");
  });

  it("degrades optional failures and accepts complete scorecards", () => {
    const degraded = policy.decide(
      input([
        result({
          errorCode: "EVAL_PROVIDER_UNAVAILABLE",
          passed: false,
          required: false,
          status: "error",
        }),
      ]),
    );
    expect(degraded.action).toBe("degraded");
    expect(policy.decide(input()).action).toBe("accepted");
  });
});

function input(results: readonly EvalCheckResult[] = [result()]) {
  return {
    canRepair: false,
    maxRepairAttempts: 0 as const,
    operationReceipts: [],
    repairAttemptsUsed: 0,
    scorecard: scorecard(results),
  };
}

function scorecard(results: readonly EvalCheckResult[] = [result()]): EvaluationScorecard {
  const requiredPassed = results.every((item) => !item.required || item.passed);
  return {
    attemptId: "attempt",
    averageScore: requiredPassed ? 1 : 0,
    counts: {
      error: results.filter((item) => item.status === "error").length,
      failed: results.filter((item) => item.status === "failed").length,
      "not-run": results.filter((item) => item.status === "not-run").length,
      passed: results.filter((item) => item.status === "passed").length,
    },
    digest: "a".repeat(64),
    dimensionScores: {
      correctness: 1,
      performance: 1,
      "resource-efficiency": 1,
      "safety-reliability": 1,
    },
    durationMs: 1,
    finalOutputDigest: "b".repeat(64),
    grade: "S",
    hardGatePassed: !results.some((item) => item.severity === "blocker" && !item.passed),
    overallScore: 1,
    passed: requiredPassed,
    planDigest: "c".repeat(64),
    qualityPassed: requiredPassed,
    results,
    runId: "run",
    taskId: "task",
    version: 1,
  };
}

function result(overrides: Partial<EvalCheckResult> = {}): EvalCheckResult {
  return {
    dimension: "correctness",
    durationMs: 1,
    evaluator: "test",
    evidenceRefs: ["evidence"],
    id: "check",
    label: "Check",
    passed: true,
    required: true,
    retryable: false,
    score: 1,
    severity: "error",
    status: "passed",
    summary: "Summary.",
    version: 1,
    ...overrides,
  };
}
