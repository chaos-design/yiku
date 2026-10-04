import { sha256Digest } from "./canonical.js";
import { EvaluationError } from "./errors.js";
import type {
  EvalCheckResult,
  EvalCheckStatus,
  EvalDimension,
  EvalExecutionContext,
  EvalPlan,
  EvaluationScorecard,
} from "./types.js";
import { EVAL_DIMENSIONS, validateEvalCheckResult } from "./validation.js";

export function createEvaluationScorecard(
  plan: EvalPlan,
  context: EvalExecutionContext,
  inputResults: readonly EvalCheckResult[],
  durationMs: number,
): EvaluationScorecard {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation scorecard duration must be non-negative and finite.",
    );
  }
  const resultsById = new Map<string, EvalCheckResult>();
  for (const result of inputResults) {
    const check = plan.checks.find((candidate) => candidate.id === result.id);
    if (check === undefined) {
      throw new EvaluationError(
        "EVAL_INVALID_RESULT",
        `Evaluation result does not belong to the plan: ${result.id}.`,
      );
    }
    if (resultsById.has(result.id)) {
      throw new EvaluationError(
        "EVAL_INVALID_RESULT",
        `Duplicate evaluation result: ${result.id}.`,
      );
    }
    validateEvalCheckResult(check, result);
    resultsById.set(result.id, result);
  }
  if (resultsById.size !== plan.checks.length) {
    const missing = plan.checks.find((check) => !resultsById.has(check.id));
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      `Evaluation result is missing for planned check ${missing?.id ?? "unknown"}.`,
    );
  }

  const results = Object.freeze(
    plan.checks.map((check) =>
      Object.freeze({ ...(resultsById.get(check.id) as EvalCheckResult) }),
    ),
  );
  const counts = countStatuses(results);
  const dimensionScores = scoreDimensions(plan, resultsById);
  const overallScore = roundScore(
    EVAL_DIMENSIONS.reduce(
      (total, dimension) => total + dimensionScores[dimension] * plan.dimensionWeights[dimension],
      0,
    ),
  );
  const hardGatePassed =
    !results.some((result) => result.severity === "blocker" && result.status !== "passed") &&
    !context.operationReceipts.some(
      (receipt) => receipt.result === "partial" || receipt.result === "unknown",
    );
  const requiredPassed = results.every((result) => !result.required || result.status === "passed");
  const qualityPassed = hardGatePassed && requiredPassed && overallScore >= plan.qualityThreshold;
  const averageScore =
    results.length === 0
      ? 1
      : roundScore(
          results.reduce((total, result) => total + resultScore(result), 0) / results.length,
        );
  const semantic = {
    attemptId: context.attemptId,
    averageScore,
    counts,
    dimensionScores,
    finalOutputDigest: context.finalOutputDigest,
    grade: gradeFor(overallScore),
    hardGatePassed,
    overallScore,
    planDigest: plan.digest,
    qualityPassed,
    results: results.map(semanticResult),
    runId: context.runId,
    taskId: context.taskId,
    version: 1 as const,
  };
  return Object.freeze({
    ...semantic,
    digest: sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation scorecard",
    }),
    durationMs,
    passed: qualityPassed,
    results,
  });
}

export function gradeFor(score: number): EvaluationScorecard["grade"] {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation grade score must be between 0 and 1.",
    );
  }
  if (score >= 0.95) {
    return "S";
  }
  if (score >= 0.9) {
    return "A";
  }
  if (score >= 0.8) {
    return "B";
  }
  if (score >= 0.7) {
    return "C";
  }
  return "D";
}

export function validateEvaluationScorecardDigest(scorecard: EvaluationScorecard): void {
  const digest = sha256Digest(
    {
      attemptId: scorecard.attemptId,
      averageScore: scorecard.averageScore,
      counts: scorecard.counts,
      dimensionScores: scorecard.dimensionScores,
      finalOutputDigest: scorecard.finalOutputDigest,
      grade: scorecard.grade,
      hardGatePassed: scorecard.hardGatePassed,
      overallScore: scorecard.overallScore,
      planDigest: scorecard.planDigest,
      qualityPassed: scorecard.qualityPassed,
      results: scorecard.results.map(semanticResult),
      runId: scorecard.runId,
      taskId: scorecard.taskId,
      version: scorecard.version,
    },
    {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation scorecard",
    },
  );
  if (digest !== scorecard.digest) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation scorecard digest does not match its contents.",
    );
  }
}

function countStatuses(
  results: readonly EvalCheckResult[],
): Readonly<Record<EvalCheckStatus, number>> {
  const counts: Record<EvalCheckStatus, number> = {
    error: 0,
    failed: 0,
    "not-run": 0,
    passed: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return Object.freeze(counts);
}

function scoreDimensions(
  plan: EvalPlan,
  results: ReadonlyMap<string, EvalCheckResult>,
): Readonly<Record<EvalDimension, number>> {
  const scores = {} as Record<EvalDimension, number>;
  for (const dimension of EVAL_DIMENSIONS) {
    const checks = plan.checks.filter((check) => check.dimension === dimension && check.weight > 0);
    const denominator = checks.reduce((total, check) => total + check.weight, 0);
    scores[dimension] =
      denominator === 0
        ? 1
        : roundScore(
            checks.reduce(
              (total, check) =>
                total + resultScore(results.get(check.id) as EvalCheckResult) * check.weight,
              0,
            ) / denominator,
          );
  }
  return Object.freeze(scores);
}

function resultScore(result: EvalCheckResult): number {
  if (result.status === "error" || result.status === "not-run") {
    return 0;
  }
  return result.score ?? (result.status === "passed" ? 1 : 0);
}

function semanticResult(result: EvalCheckResult) {
  return {
    dimension: result.dimension,
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    evaluator: result.evaluator,
    evidenceRefs: result.evidenceRefs,
    ...(result.feedback !== undefined ? { feedback: result.feedback } : {}),
    id: result.id,
    label: result.label,
    passed: result.passed,
    required: result.required,
    retryable: result.retryable,
    ...(result.score !== undefined ? { score: result.score } : {}),
    severity: result.severity,
    status: result.status,
    summary: result.summary,
    version: result.version,
  };
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
