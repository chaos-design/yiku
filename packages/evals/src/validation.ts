import { canonicalStringify, sha256Digest, utf8ByteLength } from "./canonical.js";
import { EvaluationError } from "./errors.js";
import type {
  EvalCheckDefinition,
  EvalCheckResult,
  EvalDimension,
  EvalExecutionContext,
  EvalPlan,
  EvalProfile,
  EvalResourceUsage,
  PlannedEvalCheck,
} from "./types.js";

export const EVAL_DIMENSIONS: readonly EvalDimension[] = Object.freeze([
  "correctness",
  "safety-reliability",
  "performance",
  "resource-efficiency",
]);
export const DEFAULT_DIMENSION_WEIGHTS: Readonly<Record<EvalDimension, number>> = Object.freeze({
  correctness: 0.5,
  performance: 0.15,
  "resource-efficiency": 0.1,
  "safety-reliability": 0.25,
});
export const DEFAULT_MAX_CONCURRENT_CHECKS = 4;
export const DEFAULT_MAX_CONCURRENT_RUNS = 8;
export const MAX_EVAL_CHECKS = 32;
export const MAX_EVAL_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_EVAL_SUMMARY_CHARACTERS = 2_000;
export const MAX_EVAL_FEEDBACK_CHARACTERS = 8_000;
export const MAX_EVAL_TIMEOUT_MS = 3_600_000;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,127})$/u;

export function validateEvalProfile(profile: EvalProfile): void {
  if (profile.version !== 1) {
    throw profileError("Evaluation profile version must be 1.");
  }
  requireIdentifier(profile.id, "Evaluation profile ID");
  if (profile.mode !== "enforce" && profile.mode !== "observe") {
    throw profileError("Evaluation profile mode must be enforce or observe.");
  }
  requireUnitInterval(profile.qualityThreshold, "Evaluation quality threshold");
  validateDimensionWeights(profile.dimensionWeights);
  validateProfileLimits(profile);

  if (!Array.isArray(profile.checks)) {
    throw profileError("Evaluation profile checks must be an array.");
  }
  if (profile.checks.length > MAX_EVAL_CHECKS) {
    throw profileError(`Evaluation profile cannot contain more than ${MAX_EVAL_CHECKS} checks.`);
  }
  if (profile.mode === "enforce" && profile.checks.length === 0) {
    throw profileError("Enforced evaluation profiles must contain at least one check.");
  }

  const ids = new Set<string>();
  for (const check of profile.checks) {
    validateCheckDefinition(check);
    if (ids.has(check.id)) {
      throw profileError(`Duplicate evaluation check ID: ${check.id}.`);
    }
    ids.add(check.id);
  }
  validateDependencies(profile.checks);

  for (const dimension of EVAL_DIMENSIONS) {
    if (
      profile.dimensionWeights[dimension] > 0 &&
      !profile.checks.some((check) => check.dimension === dimension && check.weight > 0)
    ) {
      throw profileError(
        `Evaluation dimension ${dimension} has non-zero weight but no scoring check.`,
      );
    }
  }
}

export function validateEvalPlan(plan: EvalPlan): void {
  requireIdentifier(plan.runId, "Evaluation run ID");
  requireIdentifier(plan.taskId, "Evaluation task ID");
  requireIdentifier(plan.profileId, "Evaluation profile ID");
  requireDigest(plan.digest, "Evaluation plan digest");
  if (
    !Number.isSafeInteger(plan.attemptBudget) ||
    (plan.attemptBudget !== 1 && plan.attemptBudget !== 2)
  ) {
    throw planError("Evaluation attempt budget must be 1 or 2.");
  }
  if (Number.isNaN(Date.parse(plan.createdAt))) {
    throw planError("Evaluation plan createdAt must be a valid date.");
  }

  validateEvalProfile({
    checks: plan.checks,
    dimensionWeights: plan.dimensionWeights,
    id: plan.profileId,
    limits: plan.limits,
    mode: plan.mode,
    qualityThreshold: plan.qualityThreshold,
    version: 1,
  });

  const ordinals = new Set<number>();
  for (const check of plan.checks) {
    if (!Number.isSafeInteger(check.ordinal) || check.ordinal < 0) {
      throw planError(`Evaluation check ${check.id} has an invalid ordinal.`);
    }
    if (ordinals.has(check.ordinal)) {
      throw planError(`Duplicate evaluation check ordinal: ${check.ordinal}.`);
    }
    ordinals.add(check.ordinal);
  }
}

export function validateEvalPlanDigest(plan: EvalPlan): void {
  const expected = sha256Digest(
    {
      attemptBudget: plan.attemptBudget,
      checks: plan.checks,
      createdAt: plan.createdAt,
      dimensionWeights: plan.dimensionWeights,
      limits: plan.limits,
      mode: plan.mode,
      profileId: plan.profileId,
      qualityThreshold: plan.qualityThreshold,
      runId: plan.runId,
      taskId: plan.taskId,
      version: plan.version,
    },
    {
      code: "EVAL_PLAN_UNSATISFIABLE",
      label: "Evaluation plan",
    },
  );
  if (expected !== plan.digest) {
    throw new EvaluationError(
      "EVAL_PLAN_UNSATISFIABLE",
      "Evaluation plan digest does not match its contents.",
    );
  }
}

export function validateCheckDefinition(check: EvalCheckDefinition): void {
  requireIdentifier(check.id, "Evaluation check ID");
  requireIdentifier(check.evaluator, "Evaluator key");
  requireIdentifier(check.capability, "Evaluator capability");
  if (check.concurrencyGroup !== undefined) {
    requireIdentifier(check.concurrencyGroup, "Evaluator concurrency group");
  }
  if (!EVAL_DIMENSIONS.includes(check.dimension)) {
    throw profileError(`Evaluation check ${check.id} has an invalid dimension.`);
  }
  if (!["blocker", "error", "info", "warning"].includes(check.severity)) {
    throw profileError(`Evaluation check ${check.id} has an invalid severity.`);
  }
  requirePositiveInteger(
    check.timeoutMs,
    `Evaluation check ${check.id} timeout`,
    MAX_EVAL_TIMEOUT_MS,
  );
  requireUnitInterval(check.weight, `Evaluation check ${check.id} weight`);
  if (!Array.isArray(check.dependsOn)) {
    throw profileError(`Evaluation check ${check.id} dependencies must be an array.`);
  }
  const dependencies = new Set<string>();
  for (const dependency of check.dependsOn) {
    requireIdentifier(dependency, `Evaluation check ${check.id} dependency`);
    if (dependency === check.id) {
      throw profileError(`Evaluation check ${check.id} cannot depend on itself.`);
    }
    if (dependencies.has(dependency)) {
      throw profileError(`Evaluation check ${check.id} has duplicate dependency ${dependency}.`);
    }
    dependencies.add(dependency);
  }
  canonicalStringify(check.config, {
    code: "EVAL_PROFILE_INVALID",
    label: `Evaluation check ${check.id} config`,
  });
}

export function validateEvalCheckResult(check: PlannedEvalCheck, result: EvalCheckResult): void {
  if (result.version !== 1) {
    throw invalidResult(check, "result version must be 1");
  }
  if (result.id !== check.id) {
    throw invalidResult(check, `result ID must be ${check.id}`);
  }
  if (result.evaluator !== check.evaluator) {
    throw invalidResult(check, `result evaluator must be ${check.evaluator}`);
  }
  if (result.dimension !== check.dimension) {
    throw invalidResult(check, `result dimension must be ${check.dimension}`);
  }
  if (result.required !== check.required || result.severity !== check.severity) {
    throw invalidResult(check, "result policy fields must match the planned check");
  }
  if (!["error", "failed", "not-run", "passed"].includes(result.status)) {
    throw invalidResult(check, "result status is invalid");
  }
  if (result.passed !== (result.status === "passed")) {
    throw invalidResult(check, "passed must match the result status");
  }
  if (result.score !== undefined) {
    requireUnitInterval(result.score, `Evaluation result ${check.id} score`, "EVAL_INVALID_RESULT");
  }
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    throw invalidResult(check, "duration must be a non-negative finite number");
  }
  requireBoundedText(
    result.label,
    `Evaluation result ${check.id} label`,
    200,
    "EVAL_INVALID_RESULT",
  );
  requireBoundedText(
    result.summary,
    `Evaluation result ${check.id} summary`,
    MAX_EVAL_SUMMARY_CHARACTERS,
    "EVAL_INVALID_RESULT",
  );
  if (result.feedback !== undefined) {
    requireBoundedText(
      result.feedback,
      `Evaluation result ${check.id} feedback`,
      MAX_EVAL_FEEDBACK_CHARACTERS,
      "EVAL_INVALID_RESULT",
    );
  }
  if (result.status === "error" && !result.errorCode?.trim()) {
    throw invalidResult(check, "error results must contain an error code");
  }
  if (!Array.isArray(result.evidenceRefs)) {
    throw invalidResult(check, "evidence references must be an array");
  }
  const evidence = new Set<string>();
  for (const reference of result.evidenceRefs) {
    requireBoundedText(
      reference,
      `Evaluation result ${check.id} evidence reference`,
      1_024,
      "EVAL_INVALID_RESULT",
    );
    if (evidence.has(reference)) {
      throw invalidResult(check, `contains duplicate evidence reference ${reference}`);
    }
    evidence.add(reference);
  }
  if (result.passed && check.evidenceRequired && result.evidenceRefs.length === 0) {
    throw new EvaluationError(
      "EVAL_EVIDENCE_MISSING",
      `Evaluation result ${check.id} passed without required evidence.`,
    );
  }
  validateResourceUsage(check, result.resourceUsage);
}

export function evalInputSize(context: EvalExecutionContext): number {
  const metadata = canonicalStringify(
    {
      artifacts: context.artifacts,
      attemptId: context.attemptId,
      finalOutputDigest: context.finalOutputDigest,
      flowRef: context.flowRef,
      operationReceipts: context.operationReceipts,
      researchClaimManifest: context.researchClaimManifest ?? null,
      runId: context.runId,
      runtimeMetrics: context.runtimeMetrics ?? null,
      taskId: context.taskId,
      taskSnapshotRef: context.taskSnapshotRef,
    },
    {
      code: "EVAL_INVALID_RESULT",
      label: "Evaluation context",
    },
  );
  return utf8ByteLength(context.finalOutput) + utf8ByteLength(metadata);
}

export function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw profileError(
      `${label} must contain 1 to 128 ASCII letters, digits, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

export function requireDigest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new EvaluationError("EVAL_INVALID_RESULT", `${label} must be a SHA-256 digest.`);
  }
  return value;
}

export function throwIfEvalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EvaluationError("EVAL_ABORTED", "Evaluation was aborted.", {
      cause: signal.reason,
    });
  }
}

function validateDimensionWeights(weights: Readonly<Record<EvalDimension, number>>): void {
  const keys = Object.keys(weights).toSorted();
  if (
    keys.length !== EVAL_DIMENSIONS.length ||
    keys.some((key, index) => key !== EVAL_DIMENSIONS.toSorted()[index])
  ) {
    throw profileError("Evaluation dimension weights must contain exactly four dimensions.");
  }
  let total = 0;
  for (const dimension of EVAL_DIMENSIONS) {
    requireUnitInterval(weights[dimension], `Evaluation dimension ${dimension} weight`);
    total += weights[dimension];
  }
  if (Math.abs(total - 1) > Number.EPSILON * 10) {
    throw profileError("Evaluation dimension weights must sum to 1.");
  }
}

function validateProfileLimits(profile: EvalProfile): void {
  requirePositiveInteger(profile.limits.maxConcurrentChecks, "Evaluation max concurrent checks", 8);
  requirePositiveInteger(
    profile.limits.maxInputBytes,
    "Evaluation max input bytes",
    MAX_EVAL_INPUT_BYTES,
  );
  if (profile.limits.maxRepairAttempts !== 0 && profile.limits.maxRepairAttempts !== 1) {
    throw profileError("Evaluation max repair attempts must be 0 or 1.");
  }
  requirePositiveInteger(profile.limits.timeoutMs, "Evaluation timeout", MAX_EVAL_TIMEOUT_MS);
}

function validateDependencies(checks: readonly EvalCheckDefinition[]): void {
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const check of checks) {
    for (const dependency of check.dependsOn) {
      if (!byId.has(dependency)) {
        throw profileError(`Evaluation check ${check.id} depends on unknown check ${dependency}.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw profileError(`Evaluation check dependency graph contains a cycle at ${id}.`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const check of checks) {
    visit(check.id);
  }
}

function validateResourceUsage(
  check: PlannedEvalCheck,
  usage: EvalResourceUsage | undefined,
): void {
  if (usage === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw invalidResult(check, `resource usage ${key} must be non-negative and finite`);
    }
  }
}

function requirePositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw profileError(`${label} must be an integer between 1 and ${maximum}.`);
  }
}

function requireUnitInterval(
  value: number,
  label: string,
  code: "EVAL_INVALID_RESULT" | "EVAL_PROFILE_INVALID" = "EVAL_PROFILE_INVALID",
): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvaluationError(code, `${label} must be between 0 and 1.`);
  }
}

function requireBoundedText(
  value: string,
  label: string,
  maximum: number,
  code: "EVAL_INVALID_RESULT" | "EVAL_PROFILE_INVALID",
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new EvaluationError(code, `${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function profileError(message: string): EvaluationError {
  return new EvaluationError("EVAL_PROFILE_INVALID", message);
}

function planError(message: string): EvaluationError {
  return new EvaluationError("EVAL_PLAN_UNSATISFIABLE", message);
}

function invalidResult(check: PlannedEvalCheck, reason: string): EvaluationError {
  return new EvaluationError(
    "EVAL_INVALID_RESULT",
    `Evaluator ${check.evaluator} returned an invalid result for ${check.id}: ${reason}.`,
  );
}
