import { sha256Text } from "./canonical.js";
import { EvaluationError } from "./errors.js";
import type { EvaluatorRegistry } from "./evaluator-registry.js";
import { AsyncSemaphore, type SemaphoreLease } from "./limits.js";
import {
  incrementEvalMetric,
  NoopEvalLogger,
  NoopEvalMetrics,
  observeEvalMetric,
  writeEvalLog,
} from "./observability.js";
import { createEvaluationScorecard } from "./scoring.js";
import type {
  EvalCheckResult,
  EvalExecutionContext,
  EvalLogger,
  EvalMetrics,
  EvalPlan,
  EvaluationScorecard,
  PlannedEvalCheck,
} from "./types.js";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  evalInputSize,
  requireIdentifier,
  throwIfEvalAborted,
  validateEvalCheckResult,
  validateEvalPlan,
  validateEvalPlanDigest,
} from "./validation.js";

export interface EvalSchedulerOptions {
  readonly clock?: (() => Date) | undefined;
  readonly concurrencyGroupLimits?: Readonly<Record<string, number>> | undefined;
  readonly logger?: EvalLogger | undefined;
  readonly maxConcurrentRuns?: number | undefined;
  readonly metrics?: EvalMetrics | undefined;
  readonly now?: (() => number) | undefined;
  readonly registry: EvaluatorRegistry;
  readonly runLimiter?: AsyncSemaphore | undefined;
}

interface LinkedSignal {
  cleanup(): void;
  readonly signal: AbortSignal;
  timedOut(): boolean;
}

interface CompletedCheck {
  readonly id: string;
  readonly result: EvalCheckResult;
}

const ERROR_MESSAGE_LIMIT = 1_000;
const SECRET_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,})/gu;

export class EvalScheduler {
  private readonly clock: () => Date;
  private readonly groupLimits = new Map<string, AsyncSemaphore>();
  private readonly logger: EvalLogger;
  private readonly metrics: EvalMetrics;
  private readonly now: () => number;
  private readonly registry: EvaluatorRegistry;
  private readonly runLimiter: AsyncSemaphore;

  public constructor(options: EvalSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? new NoopEvalLogger();
    this.metrics = options.metrics ?? new NoopEvalMetrics();
    this.now = options.now ?? (() => performance.now());
    this.registry = options.registry;
    const maxConcurrentRuns = concurrencyLimit(
      options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
      "Evaluation max concurrent runs",
    );
    this.runLimiter = options.runLimiter ?? new AsyncSemaphore(maxConcurrentRuns, this.now);

    for (const [group, maximum] of Object.entries(options.concurrencyGroupLimits ?? {})) {
      requireIdentifier(group, "Evaluator concurrency group");
      this.groupLimits.set(
        group,
        new AsyncSemaphore(
          concurrencyLimit(maximum, `Evaluator concurrency group ${group}`),
          this.now,
        ),
      );
    }
  }

  public async run(plan: EvalPlan, context: EvalExecutionContext): Promise<EvaluationScorecard> {
    validateSchedulerInput(plan, context);
    throwIfEvalAborted(context.signal);
    const runLease = await this.runLimiter.acquire(context.signal);
    observeEvalMetric(this.metrics, "eval_scheduler_queue_ms", runLease.queuedMs, {
      profile: plan.profileId,
    });
    const startedAt = this.now();
    const attemptSignal = linkedSignal(context.signal, plan.limits.timeoutMs);
    writeEvalLog(this.logger, {
      attemptId: context.attemptId,
      event: "evaluation.started",
      level: "info",
      runId: context.runId,
      taskId: context.taskId,
      timestamp: this.clock().toISOString(),
    });

    try {
      const results = await this.runChecks(plan, context, attemptSignal);
      throwIfEvalAborted(context.signal);
      const durationMs = Math.max(0, this.now() - startedAt);
      const scorecard = createEvaluationScorecard(plan, context, results, durationMs);
      incrementEvalMetric(this.metrics, "eval_runs_total", {
        mode: plan.mode,
        profile: plan.profileId,
        status: scorecard.passed ? "passed" : "failed",
      });
      observeEvalMetric(this.metrics, "eval_attempt_duration_ms", durationMs, {
        profile: plan.profileId,
        status: scorecard.passed ? "passed" : "failed",
      });
      writeEvalLog(this.logger, {
        attemptId: context.attemptId,
        durationMs,
        event: "evaluation.finished",
        level: "info",
        runId: context.runId,
        status: scorecard.passed ? "passed" : "failed",
        taskId: context.taskId,
        timestamp: this.clock().toISOString(),
      });
      return scorecard;
    } finally {
      attemptSignal.cleanup();
      runLease.release();
    }
  }

  private async runChecks(
    plan: EvalPlan,
    context: EvalExecutionContext,
    attemptSignal: LinkedSignal,
  ): Promise<readonly EvalCheckResult[]> {
    const pending = new Map(plan.checks.map((check) => [check.id, check]));
    const running = new Map<string, Promise<CompletedCheck>>();
    const results = new Map<string, EvalCheckResult>();

    try {
      while (pending.size > 0 || running.size > 0) {
        throwIfEvalAborted(context.signal);
        this.skipBlockedChecks(pending, results, context, attemptSignal.timedOut());

        if (!attemptSignal.signal.aborted) {
          const ready = [...pending.values()]
            .filter((check) => check.dependsOn.every((id) => results.get(id)?.status === "passed"))
            .toSorted((left, right) => left.ordinal - right.ordinal);
          while (ready.length > 0 && running.size < plan.limits.maxConcurrentChecks) {
            const check = ready.shift() as PlannedEvalCheck;
            pending.delete(check.id);
            running.set(
              check.id,
              this.executeCheck(check, context, attemptSignal.signal).then((result) => ({
                id: check.id,
                result,
              })),
            );
          }
        }

        if (running.size === 0) {
          if (pending.size === 0) {
            break;
          }
          if (attemptSignal.timedOut()) {
            this.skipBlockedChecks(pending, results, context, true);
            continue;
          }
          throw new EvaluationError(
            "EVAL_PLAN_UNSATISFIABLE",
            "Evaluation scheduler could not make progress.",
          );
        }

        const completed = await Promise.race(running.values());
        running.delete(completed.id);
        results.set(completed.id, completed.result);
      }
    } catch (error) {
      await Promise.allSettled(running.values());
      throw error;
    }

    return plan.checks.map((check) => {
      const result = results.get(check.id);
      if (result === undefined) {
        throw new EvaluationError(
          "EVAL_INVALID_RESULT",
          `Evaluation scheduler did not produce a result for ${check.id}.`,
        );
      }
      return result;
    });
  }

  private skipBlockedChecks(
    pending: Map<string, PlannedEvalCheck>,
    results: ReadonlyMap<string, EvalCheckResult>,
    context: EvalExecutionContext,
    timedOut: boolean,
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const check of pending.values()) {
        const dependencies = check.dependsOn.map((id) => results.get(id));
        const blocked = dependencies.find(
          (result) => result !== undefined && result.status !== "passed",
        );
        if (blocked === undefined && !timedOut) {
          continue;
        }
        pending.delete(check.id);
        const result = notRunResult(
          check,
          timedOut ? "EVAL_TIMEOUT" : "EVAL_DEPENDENCY_FAILED",
          timedOut
            ? "Evaluation attempt timed out before the check could run."
            : `Dependency ${blocked?.id ?? "unknown"} did not pass.`,
        );
        (results as Map<string, EvalCheckResult>).set(check.id, result);
        this.recordCheck(context, result);
        changed = true;
      }
    }
  }

  private async executeCheck(
    check: PlannedEvalCheck,
    context: EvalExecutionContext,
    attemptSignal: AbortSignal,
  ): Promise<EvalCheckResult> {
    const evaluator = this.registry.get(check.evaluator);
    if (evaluator === undefined) {
      const result = notRunResult(
        check,
        "EVAL_PLAN_UNSATISFIABLE",
        `Evaluator ${check.evaluator} is unavailable.`,
      );
      this.recordCheck(context, result);
      return result;
    }

    const startedAt = this.now();
    const checkSignal = linkedSignal(attemptSignal, check.timeoutMs);
    let groupLease: SemaphoreLease | undefined;
    writeEvalLog(this.logger, {
      attemptId: context.attemptId,
      checkId: check.id,
      event: "evaluation.check.started",
      level: "debug",
      runId: context.runId,
      taskId: context.taskId,
      timestamp: this.clock().toISOString(),
    });

    try {
      groupLease = await this.groupLimit(check)?.acquire(checkSignal.signal);
      const rawResult = await raceWithAbort(
        Promise.resolve(
          evaluator.evaluate(check, {
            ...context,
            signal: checkSignal.signal,
          }),
        ),
        checkSignal.signal,
      );
      const result: EvalCheckResult = {
        ...rawResult,
        durationMs: Math.max(0, this.now() - startedAt),
      };
      validateEvalCheckResult(check, result);
      this.recordCheck(context, result);
      return Object.freeze({
        ...result,
        evidenceRefs: Object.freeze([...result.evidenceRefs]),
      });
    } catch (error) {
      if (context.signal?.aborted) {
        throw new EvaluationError("EVAL_ABORTED", "Evaluation was aborted.", {
          cause: context.signal.reason,
        });
      }
      const result = evaluatorErrorResult(
        check,
        checkSignal.timedOut() || attemptSignal.aborted ? "EVAL_TIMEOUT" : errorCode(error),
        checkSignal.timedOut() || attemptSignal.aborted
          ? "Evaluation check timed out."
          : safeErrorMessage(error),
        Math.max(0, this.now() - startedAt),
      );
      this.recordCheck(context, result);
      return result;
    } finally {
      groupLease?.release();
      checkSignal.cleanup();
    }
  }

  private groupLimit(check: PlannedEvalCheck): AsyncSemaphore | undefined {
    if (check.concurrencyGroup === undefined) {
      return undefined;
    }
    const existing = this.groupLimits.get(check.concurrencyGroup);
    if (existing !== undefined) {
      return existing;
    }
    const semaphore = new AsyncSemaphore(1, this.now);
    this.groupLimits.set(check.concurrencyGroup, semaphore);
    return semaphore;
  }

  private recordCheck(context: EvalExecutionContext, result: EvalCheckResult): void {
    incrementEvalMetric(this.metrics, "eval_checks_total", {
      evaluator: result.evaluator,
      required: result.required ? "true" : "false",
      status: result.status,
    });
    observeEvalMetric(this.metrics, "eval_check_duration_ms", result.durationMs, {
      evaluator: result.evaluator,
      status: result.status,
    });
    if (result.errorCode !== undefined) {
      incrementEvalMetric(this.metrics, "eval_errors_total", {
        component: "evaluator",
        errorCode: result.errorCode,
      });
    }
    writeEvalLog(this.logger, {
      attemptId: context.attemptId,
      checkId: result.id,
      durationMs: result.durationMs,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      event: "evaluation.check.finished",
      level: result.status === "error" ? "warn" : "info",
      runId: context.runId,
      status: result.status,
      taskId: context.taskId,
      timestamp: this.clock().toISOString(),
    });
  }
}

function validateSchedulerInput(plan: EvalPlan, context: EvalExecutionContext): void {
  validateEvalPlan(plan);
  validateEvalPlanDigest(plan);
  if (context.runId !== plan.runId || context.taskId !== plan.taskId) {
    throw new EvaluationError(
      "EVAL_PLAN_UNSATISFIABLE",
      "Evaluation context does not belong to the plan.",
    );
  }
  requireIdentifier(context.attemptId, "Evaluation attempt ID");
  if (sha256Text(context.finalOutput) !== context.finalOutputDigest) {
    throw new EvaluationError(
      "EVAL_ARTIFACT_CHANGED",
      "Evaluation final output digest does not match its contents.",
    );
  }
  const size = evalInputSize(context);
  if (size > plan.limits.maxInputBytes) {
    throw new EvaluationError(
      "EVAL_INPUT_TOO_LARGE",
      `Evaluation input contains ${size} bytes, exceeding the ${plan.limits.maxInputBytes} byte limit.`,
    );
  }
}

function notRunResult(
  check: PlannedEvalCheck,
  errorCode: string,
  summary: string,
): EvalCheckResult {
  return Object.freeze({
    dimension: check.dimension,
    durationMs: 0,
    errorCode,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze([]),
    id: check.id,
    label: check.id,
    passed: false,
    required: check.required,
    retryable: false,
    score: 0,
    severity: check.severity,
    status: "not-run",
    summary,
    version: 1,
  });
}

function evaluatorErrorResult(
  check: PlannedEvalCheck,
  errorCode: string,
  summary: string,
  durationMs: number,
): EvalCheckResult {
  return Object.freeze({
    dimension: check.dimension,
    durationMs,
    errorCode,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze([]),
    id: check.id,
    label: check.id,
    passed: false,
    required: check.required,
    retryable:
      errorCode === "EVAL_NETWORK_UNAVAILABLE" ||
      errorCode === "EVAL_PROVIDER_UNAVAILABLE" ||
      errorCode === "EVAL_TIMEOUT",
    score: 0,
    severity: check.severity,
    status: "error",
    summary,
    version: 1,
  });
}

function errorCode(error: unknown): string {
  if (error instanceof EvaluationError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "EVAL_EVALUATOR_FAILED";
}

function safeErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(SECRET_PATTERN, "[REDACTED]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return (message || "Evaluator failed.").slice(0, ERROR_MESSAGE_LIMIT);
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): LinkedSignal {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = () => {
    controller.abort(parent?.reason);
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) {
    onAbort();
  }
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new EvaluationError("EVAL_TIMEOUT", "Evaluation timed out."));
  }, timeoutMs);
  return {
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
    signal: controller.signal,
    timedOut() {
      return timeoutReached;
    },
  };
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      finish(() => reject(signal.reason));
    };
    const finish = (complete: () => void) => {
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function concurrencyLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_CONCURRENT_RUNS) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `${label} must be an integer between 1 and ${DEFAULT_MAX_CONCURRENT_RUNS}.`,
    );
  }
  return value;
}
