import { sha256Digest } from "./canonical.js";
import { EvaluationError } from "./errors.js";
import { validateCompletionDecision } from "./records.js";
import { validateEvaluationScorecardDigest } from "./scoring.js";
import type {
  CompletionDecision,
  EvalBaseline,
  EvalBaselineComparison,
  EvaluationScorecard,
} from "./types.js";
import { EVAL_DIMENSIONS, requireDigest, requireIdentifier } from "./validation.js";

export interface CreateEvalBaselineInput {
  readonly approvedAt: string;
  readonly approvedBy?: string | undefined;
  readonly baselineVersion: string;
  readonly decision: CompletionDecision;
  readonly evaluatorVersions: Readonly<Record<string, string>>;
  readonly profileId: string;
  readonly runtimeDigest: string;
  readonly scorecard: EvaluationScorecard;
  readonly suiteId: string;
}

export interface CompareEvalBaselineOptions {
  readonly scoreTolerance?: number | undefined;
}

export function createEvalBaseline(input: CreateEvalBaselineInput): EvalBaseline {
  validateCompletionDecision(input.decision);
  validateEvaluationScorecardDigest(input.scorecard);
  if (
    input.decision.action !== "accepted" ||
    !input.scorecard.passed ||
    !input.scorecard.hardGatePassed
  ) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Only accepted scorecards without hard-gate failures can become baselines.",
    );
  }
  if (input.decision.attemptId !== input.scorecard.attemptId) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Baseline decision and scorecard must belong to the same attempt.",
    );
  }
  requireIdentifier(input.suiteId, "Evaluation baseline suite ID");
  requireIdentifier(input.baselineVersion, "Evaluation baseline version");
  requireIdentifier(input.profileId, "Evaluation baseline profile ID");
  requireDigest(input.runtimeDigest, "Evaluation baseline runtime digest");
  if (Number.isNaN(Date.parse(input.approvedAt))) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation baseline approvedAt must be a valid date.",
    );
  }
  if (input.approvedBy !== undefined && !input.approvedBy.trim()) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation baseline approvedBy must be non-empty when provided.",
    );
  }
  for (const [key, version] of Object.entries(input.evaluatorVersions)) {
    requireIdentifier(key, "Evaluation baseline evaluator key");
    requireIdentifier(version, `Evaluation baseline evaluator ${key} version`);
  }

  const semantic = {
    approvedAt: new Date(input.approvedAt).toISOString(),
    ...(input.approvedBy !== undefined ? { approvedBy: input.approvedBy.trim() } : {}),
    baselineVersion: input.baselineVersion,
    checks: input.scorecard.results.map((result) => ({
      id: result.id,
      ...(result.score !== undefined ? { score: result.score } : {}),
      status: result.status,
    })),
    dimensionScores: input.scorecard.dimensionScores,
    evaluatorVersions: input.evaluatorVersions,
    hardGatePassed: input.scorecard.hardGatePassed,
    overallScore: input.scorecard.overallScore,
    profileId: input.profileId,
    runtimeDigest: input.runtimeDigest,
    scorecardDigest: input.scorecard.digest,
    suiteId: input.suiteId,
    version: 1 as const,
  };
  return Object.freeze({
    ...semantic,
    checks: Object.freeze(semantic.checks.map((check) => Object.freeze(check))),
    digest: sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation baseline",
    }),
    dimensionScores: Object.freeze({ ...semantic.dimensionScores }),
    evaluatorVersions: Object.freeze({ ...semantic.evaluatorVersions }),
  });
}

export function compareEvalBaseline(
  baseline: EvalBaseline,
  current: EvaluationScorecard,
  options: CompareEvalBaselineOptions = {},
): EvalBaselineComparison {
  validateEvalBaseline(baseline);
  validateEvaluationScorecardDigest(current);
  const tolerance = options.scoreTolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      "Evaluation baseline score tolerance must be between 0 and 1.",
    );
  }
  const regressions: string[] = [];
  if (baseline.hardGatePassed && !current.hardGatePassed) {
    regressions.push("A hard gate that passed in the baseline no longer passes.");
  }
  const scoreDelta = round(current.overallScore - baseline.overallScore);
  if (scoreDelta < -tolerance) {
    regressions.push(
      `Overall score regressed by ${Math.abs(scoreDelta).toFixed(6)}, exceeding tolerance ${tolerance}.`,
    );
  }
  for (const dimension of EVAL_DIMENSIONS) {
    const delta = current.dimensionScores[dimension] - baseline.dimensionScores[dimension];
    if (delta < -tolerance) {
      regressions.push(`Dimension ${dimension} regressed by ${Math.abs(delta).toFixed(6)}.`);
    }
  }
  const currentById = new Map(current.results.map((result) => [result.id, result]));
  for (const baselineCheck of baseline.checks) {
    const result = currentById.get(baselineCheck.id);
    if (result === undefined) {
      regressions.push(`Baseline check ${baselineCheck.id} is missing.`);
      continue;
    }
    if (baselineCheck.status === "passed" && result.status !== "passed") {
      regressions.push(
        `Baseline check ${baselineCheck.id} changed from passed to ${result.status}.`,
      );
      continue;
    }
    if (
      baselineCheck.score !== undefined &&
      (result.score ?? 0) < baselineCheck.score - tolerance
    ) {
      regressions.push(`Baseline check ${baselineCheck.id} score regressed.`);
    }
  }
  return Object.freeze({
    currentScore: current.overallScore,
    passed: regressions.length === 0,
    regressions: Object.freeze(regressions),
    scoreDelta,
    version: 1,
  });
}

export function validateEvalBaseline(baseline: EvalBaseline): void {
  if (baseline.version !== 1) {
    throw new EvaluationError(
      "EVAL_SCHEMA_UNSUPPORTED",
      `Unsupported evaluation baseline version: ${String(baseline.version)}.`,
    );
  }
  const semantic = {
    approvedAt: baseline.approvedAt,
    ...(baseline.approvedBy !== undefined ? { approvedBy: baseline.approvedBy } : {}),
    baselineVersion: baseline.baselineVersion,
    checks: baseline.checks,
    dimensionScores: baseline.dimensionScores,
    evaluatorVersions: baseline.evaluatorVersions,
    hardGatePassed: baseline.hardGatePassed,
    overallScore: baseline.overallScore,
    profileId: baseline.profileId,
    runtimeDigest: baseline.runtimeDigest,
    scorecardDigest: baseline.scorecardDigest,
    suiteId: baseline.suiteId,
    version: baseline.version,
  };
  if (
    sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation baseline",
    }) !== baseline.digest
  ) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Evaluation baseline digest does not match its contents.",
    );
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
