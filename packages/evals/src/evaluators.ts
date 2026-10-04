import { EvaluationError } from "./errors.js";
import type {
  EvalCheckEvaluator,
  EvalCheckResult,
  EvalDimension,
  EvalExecutionContext,
  EvalInput,
  EvalPolicyMode,
  EvalProfile,
  EvalResult,
  EvalSeverity,
  Evaluator,
  PlannedEvalCheck,
} from "./types.js";
import {
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_MAX_CONCURRENT_CHECKS,
  MAX_EVAL_INPUT_BYTES,
} from "./validation.js";

const SECRET_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,})/u;

export class FlowIntegrityEvaluator implements Evaluator {
  public readonly key = "flow-integrity";
  public readonly label = "Flow Integrity";

  public evaluate(input: EvalInput): EvalResult {
    const instanceIds = new Set(input.flow.events.map((event) => event.instance.id));
    const started = new Set<string>();
    const closed = new Set<string>();
    let previousSequence = 0;
    const issues: string[] = [];

    for (const event of input.flow.events) {
      if (event.sequence <= previousSequence) {
        issues.push("non-monotonic sequence");
      }
      previousSequence = event.sequence;

      if (event.instance.parentId && !instanceIds.has(event.instance.parentId)) {
        issues.push(`orphan parent ${event.instance.parentId}`);
      }
      if (event.phase === "start") {
        started.add(event.instance.id);
      }
      if (event.phase === "end" || event.phase === "error" || event.phase === "skipped") {
        closed.add(event.instance.id);
      }
    }

    for (const instanceId of started) {
      if (!closed.has(instanceId)) {
        issues.push(`open instance ${instanceId}`);
      }
    }

    return result(this.key, this.label, issues.length === 0, issues.join("; ") || "Flow is valid.");
  }
}

export class FinalOutputEvaluator implements Evaluator {
  public readonly key = "final-output";
  public readonly label = "Final Output";

  public evaluate(input: EvalInput): EvalResult {
    const passed = Boolean(input.finalOutput.trim());
    return result(
      this.key,
      this.label,
      passed,
      passed ? "Final output is present." : "Final output is empty.",
    );
  }
}

export class MemorySafetyEvaluator implements Evaluator {
  public readonly key = "memory-safety";
  public readonly label = "Memory Safety";

  public evaluate(input: EvalInput): EvalResult {
    const memoryEvents = input.flow.events.filter((event) => event.atom.kind === "memory");
    const unsafe = memoryEvents.some((event) => SECRET_PATTERN.test(JSON.stringify(event.payload)));

    return result(
      this.key,
      this.label,
      !unsafe,
      unsafe ? "Memory event summary contains a secret pattern." : "Memory summaries are safe.",
    );
  }
}

export const DEFAULT_EVALUATORS: readonly Evaluator[] = Object.freeze([
  new FlowIntegrityEvaluator(),
  new FinalOutputEvaluator(),
  new MemorySafetyEvaluator(),
]);

export class FlowIntegrityCheckEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "flow-integrity",
    deterministic: true,
    key: "flow-integrity-v2",
    label: "Flow Integrity",
    version: "2.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const legacy = new FlowIntegrityEvaluator().evaluate({
      finalOutput: context.finalOutput,
      flow: context.flow,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    return checkResult(check, this.descriptor.label, legacy, [context.flowRef]);
  }
}

export class FinalOutputCheckEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "final-output",
    deterministic: true,
    key: "final-output-v2",
    label: "Final Output",
    version: "2.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const legacy = new FinalOutputEvaluator().evaluate({
      finalOutput: context.finalOutput,
      flow: context.flow,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    return checkResult(check, this.descriptor.label, legacy, [
      `output:sha256:${context.finalOutputDigest}`,
    ]);
  }
}

export class MemorySafetyCheckEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "memory-safety",
    deterministic: true,
    key: "memory-safety-v2",
    label: "Memory Safety",
    version: "2.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const legacy = new MemorySafetyEvaluator().evaluate({
      finalOutput: context.finalOutput,
      flow: context.flow,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    return checkResult(check, this.descriptor.label, legacy, [context.flowRef]);
  }
}

export class PerformanceBudgetEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "performance-budget",
    deterministic: true,
    key: "performance-budget",
    label: "Performance Budget",
    version: "1.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    return budgetResult(
      check,
      this.descriptor.label,
      context.runtimeMetrics?.durationMs,
      "durationMs",
      context,
    );
  }
}

export class ResourceBudgetEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = Object.freeze({
    capability: "resource-budget",
    deterministic: true,
    key: "resource-budget",
    label: "Resource Budget",
    version: "1.0.0",
  });

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    return budgetResult(
      check,
      this.descriptor.label,
      context.runtimeMetrics?.peakRssBytes,
      "peakRssBytes",
      context,
    );
  }
}

export const DEFAULT_CHECK_EVALUATORS: readonly EvalCheckEvaluator[] = Object.freeze([
  new FinalOutputCheckEvaluator(),
  new FlowIntegrityCheckEvaluator(),
  new MemorySafetyCheckEvaluator(),
  new PerformanceBudgetEvaluator(),
  new ResourceBudgetEvaluator(),
]);

export interface DefaultEvalProfileOptions {
  readonly id?: string | undefined;
  readonly maxConcurrentChecks?: number | undefined;
  readonly maxInputBytes?: number | undefined;
  readonly maxRepairAttempts?: 0 | 1 | undefined;
  readonly mode?: EvalPolicyMode | undefined;
  readonly qualityThreshold?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createDefaultEvalProfile(options: DefaultEvalProfileOptions = {}): EvalProfile {
  return Object.freeze({
    checks: Object.freeze([
      checkDefinition(
        "flow-integrity",
        "flow-integrity-v2",
        "flow-integrity",
        "correctness",
        "error",
      ),
      checkDefinition("final-output", "final-output-v2", "final-output", "correctness", "error"),
      checkDefinition(
        "memory-safety",
        "memory-safety-v2",
        "memory-safety",
        "safety-reliability",
        "blocker",
      ),
      {
        ...checkDefinition(
          "performance-budget",
          "performance-budget",
          "performance-budget",
          "performance",
          "warning",
        ),
        config: Object.freeze({
          limit: 900_000,
          target: 600_000,
        }),
      },
      {
        ...checkDefinition(
          "resource-budget",
          "resource-budget",
          "resource-budget",
          "resource-efficiency",
          "warning",
        ),
        config: Object.freeze({
          limit: 384 * 1024 * 1024,
          target: 256 * 1024 * 1024,
        }),
      },
    ]),
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: options.id ?? "default",
    limits: Object.freeze({
      maxConcurrentChecks: options.maxConcurrentChecks ?? DEFAULT_MAX_CONCURRENT_CHECKS,
      maxInputBytes: options.maxInputBytes ?? MAX_EVAL_INPUT_BYTES,
      maxRepairAttempts: options.maxRepairAttempts ?? 1,
      timeoutMs: options.timeoutMs ?? 600_000,
    }),
    mode: options.mode ?? "observe",
    qualityThreshold: options.qualityThreshold ?? 0.8,
    version: 1,
  });
}

function result(key: string, label: string, passed: boolean, summary: string): EvalResult {
  return {
    key,
    label,
    passed,
    score: passed ? 1 : 0,
    summary,
  };
}

function checkDefinition(
  id: string,
  evaluator: string,
  capability: string,
  dimension: EvalDimension,
  severity: EvalSeverity,
) {
  return Object.freeze({
    capability,
    config: Object.freeze({}),
    dependsOn: Object.freeze([]),
    dimension,
    evaluator,
    evidenceRequired: true,
    id,
    required: true,
    severity,
    timeoutMs: 30_000,
    weight: 1,
  });
}

function checkResult(
  check: PlannedEvalCheck,
  label: string,
  legacy: EvalResult,
  evidenceRefs: readonly string[],
): EvalCheckResult {
  return Object.freeze({
    dimension: check.dimension,
    durationMs: 0,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    id: check.id,
    label,
    passed: legacy.passed,
    required: check.required,
    retryable: !legacy.passed,
    score: legacy.score,
    severity: check.severity,
    status: legacy.passed ? "passed" : "failed",
    summary: legacy.summary,
    version: 1,
  });
}

function budgetResult(
  check: PlannedEvalCheck,
  label: string,
  value: number | undefined,
  metric: string,
  context: EvalExecutionContext,
): EvalCheckResult {
  if (value === undefined) {
    return Object.freeze({
      dimension: check.dimension,
      durationMs: 0,
      errorCode: "EVAL_EVIDENCE_MISSING",
      evaluator: check.evaluator,
      evidenceRefs: Object.freeze([]),
      id: check.id,
      label,
      passed: false,
      required: check.required,
      retryable: false,
      score: 0,
      severity: check.severity,
      status: "not-run",
      summary: `Runtime metric ${metric} is unavailable.`,
      version: 1,
    });
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      `Runtime metric ${metric} must be non-negative and finite.`,
    );
  }
  const target = configNumber(check, "target");
  const limit = configNumber(check, "limit");
  if (target > limit) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Evaluation check ${check.id} target must not exceed its limit.`,
    );
  }
  const score =
    value <= target ? 1 : value >= limit ? 0 : (limit - value) / Math.max(1, limit - target);
  const passed = value < limit;
  return Object.freeze({
    dimension: check.dimension,
    durationMs: 0,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze([`resource:${context.attemptId}:${metric}`]),
    id: check.id,
    label,
    passed,
    required: check.required,
    resourceUsage: Object.freeze({
      ...(metric === "durationMs" ? { cpuMs: context.runtimeMetrics?.cpuMs } : {}),
      ...(metric === "peakRssBytes" ? { peakRssBytes: value } : {}),
    }),
    retryable: false,
    score,
    severity: check.severity,
    status: passed ? "passed" : "failed",
    summary: `${metric}=${value}; target=${target}; limit=${limit}.`,
    version: 1,
  });
}

function configNumber(check: PlannedEvalCheck, key: string): number {
  const value = check.config[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Evaluation check ${check.id} config ${key} must be non-negative and finite.`,
    );
  }
  return value;
}
