import { validateEvalBaseline } from "../baseline.js";
import { EvaluationError, unsupportedEvaluationVersion } from "../errors.js";
import {
  validateCompletionDecision,
  validateEvalAttemptRecord,
  validateEvalEvidenceIndex,
} from "../records.js";
import { gradeFor, validateEvaluationScorecardDigest } from "../scoring.js";
import type {
  CompletionDecision,
  EvalAttemptRecord,
  EvalBaseline,
  EvalCheckResult,
  EvalCheckStatus,
  EvalEvidenceIndex,
  EvalPlan,
  EvaluationScorecard,
} from "../types.js";
import {
  EVAL_DIMENSIONS,
  requireDigest,
  validateEvalPlan,
  validateEvalPlanDigest,
} from "../validation.js";

export function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw corrupt(`${label} is not valid JSON.`, error);
  }
}

export function parseStoredEvalPlan(value: unknown): EvalPlan {
  return parseRecord(value, "Evaluation plan", (record) => {
    validateEvalPlan(record as unknown as EvalPlan);
    validateEvalPlanDigest(record as unknown as EvalPlan);
    return record as unknown as EvalPlan;
  });
}

export function parseStoredBaseline(value: unknown): EvalBaseline {
  return parseRecord(value, "Evaluation baseline", (record) => {
    validateEvalBaseline(record as unknown as EvalBaseline);
    return record as unknown as EvalBaseline;
  });
}

export function parseStoredEvalAttempt(value: unknown): EvalAttemptRecord {
  return parseRecord(value, "Evaluation attempt", (record) => {
    validateEvalAttemptRecord(record as unknown as EvalAttemptRecord);
    return record as unknown as EvalAttemptRecord;
  });
}

export function parseStoredEvidenceIndex(value: unknown): EvalEvidenceIndex {
  return parseRecord(value, "Evaluation evidence index", (record) => {
    validateEvalEvidenceIndex(record as unknown as EvalEvidenceIndex);
    return record as unknown as EvalEvidenceIndex;
  });
}

export function parseStoredDecision(value: unknown): CompletionDecision {
  return parseRecord(value, "Evaluation completion decision", (record) => {
    validateCompletionDecision(record as unknown as CompletionDecision);
    return record as unknown as CompletionDecision;
  });
}

export function parseStoredScorecard(value: unknown): EvaluationScorecard {
  return parseRecord(value, "Evaluation scorecard", (record) => {
    assertScorecard(record);
    const scorecard = record as unknown as EvaluationScorecard;
    validateEvaluationScorecardDigest(scorecard);
    return scorecard;
  });
}

function assertScorecard(record: Record<string, unknown>): void {
  for (const key of ["attemptId", "digest", "finalOutputDigest", "planDigest", "runId", "taskId"]) {
    requireString(record[key], `Evaluation scorecard ${key}`);
  }
  requireDigest(record.digest as string, "Evaluation scorecard digest");
  requireDigest(record.finalOutputDigest as string, "Evaluation output digest");
  requireDigest(record.planDigest as string, "Evaluation plan digest");
  for (const key of ["averageScore", "durationMs", "overallScore"]) {
    requireNonNegativeNumber(record[key], `Evaluation scorecard ${key}`);
  }
  if ((record.averageScore as number) > 1 || (record.overallScore as number) > 1) {
    throw new Error("Evaluation scorecard scores must not exceed 1.");
  }
  for (const key of ["hardGatePassed", "passed", "qualityPassed"]) {
    if (typeof record[key] !== "boolean") {
      throw new Error(`Evaluation scorecard ${key} must be a boolean.`);
    }
  }
  if (record.passed !== record.qualityPassed) {
    throw new Error("Evaluation scorecard passed must match qualityPassed.");
  }
  if (record.version !== 1) {
    throw unsupportedEvaluationVersion("scorecard", record.version);
  }
  if (record.grade !== gradeFor(record.overallScore as number)) {
    throw new Error("Evaluation scorecard grade does not match its overall score.");
  }
  const dimensions = requireRecord(record.dimensionScores, "Evaluation dimension scores");
  for (const dimension of EVAL_DIMENSIONS) {
    const value = dimensions[dimension];
    requireNonNegativeNumber(value, `Evaluation dimension ${dimension}`);
    if ((value as number) > 1) {
      throw new Error(`Evaluation dimension ${dimension} must not exceed 1.`);
    }
  }
  const results = requireArray(record.results, "Evaluation scorecard results").map((result) =>
    assertCheckResult(result),
  );
  const counts = requireRecord(record.counts, "Evaluation scorecard counts");
  const expected: Record<EvalCheckStatus, number> = {
    error: 0,
    failed: 0,
    "not-run": 0,
    passed: 0,
  };
  for (const result of results) {
    expected[result.status] += 1;
  }
  for (const [status, count] of Object.entries(expected)) {
    if (counts[status] !== count) {
      throw new Error(`Evaluation scorecard count for ${status} is inconsistent.`);
    }
  }
}

function assertCheckResult(value: unknown): EvalCheckResult {
  const result = requireRecord(value, "Evaluation check result");
  for (const key of ["evaluator", "id", "label", "summary"]) {
    requireString(result[key], `Evaluation check result ${key}`);
  }
  if (!EVAL_DIMENSIONS.includes(result.dimension as (typeof EVAL_DIMENSIONS)[number])) {
    throw new Error("Evaluation check result dimension is invalid.");
  }
  if (!["blocker", "error", "info", "warning"].includes(result.severity as string)) {
    throw new Error("Evaluation check result severity is invalid.");
  }
  if (!["error", "failed", "not-run", "passed"].includes(result.status as string)) {
    throw new Error("Evaluation check result status is invalid.");
  }
  if (result.passed !== (result.status === "passed")) {
    throw new Error("Evaluation check result passed is inconsistent.");
  }
  for (const key of ["passed", "required", "retryable"]) {
    if (typeof result[key] !== "boolean") {
      throw new Error(`Evaluation check result ${key} must be a boolean.`);
    }
  }
  requireNonNegativeNumber(result.durationMs, "Evaluation check result duration");
  if (result.score !== undefined) {
    requireNonNegativeNumber(result.score, "Evaluation check result score");
    if ((result.score as number) > 1) {
      throw new Error("Evaluation check result score must not exceed 1.");
    }
  }
  if (result.status === "error") {
    requireString(result.errorCode, "Evaluation check result errorCode");
  }
  const evidenceRefs = requireArray(
    result.evidenceRefs,
    "Evaluation check result evidence references",
  );
  if (evidenceRefs.some((reference) => typeof reference !== "string" || !reference.trim())) {
    throw new Error("Evaluation evidence references must be non-empty strings.");
  }
  if (result.version !== 1) {
    throw unsupportedEvaluationVersion("check result", result.version);
  }
  return result as unknown as EvalCheckResult;
}

function parseRecord<T>(
  value: unknown,
  label: string,
  parse: (record: Record<string, unknown>) => T,
): T {
  try {
    const record = requireRecord(value, label);
    if ("version" in record && record.version !== 1) {
      throw unsupportedEvaluationVersion(label.toLowerCase(), record.version);
    }
    return parse(record);
  } catch (error) {
    if (error instanceof EvaluationError && error.code === "EVAL_SCHEMA_UNSUPPORTED") {
      throw error;
    }
    throw corrupt(`${label} is corrupt or does not match its schema.`, error);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function corrupt(message: string, cause?: unknown): EvaluationError {
  return new EvaluationError("EVAL_STORE_CORRUPT", message, { cause });
}
