import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  AsyncSemaphore,
  DEFAULT_DIMENSION_WEIGHTS,
  EvalPlanner,
  EvalScheduler,
  EvaluationError,
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

describe("EvalScheduler", () => {
  it("runs a stable dependency graph with bounded concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const starts: string[] = [];
    const checks = dimensionChecks();
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, async (check) => {
        starts.push(check.id);
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(5);
        active -= 1;
        return passed(check);
      }),
    );
    const plan = createPlan(
      checks.map((check) =>
        check.id === "safety" ? { ...check, dependsOn: ["correctness"] } : check,
      ),
      evaluators,
      2,
    );
    const scorecard = await new EvalScheduler({
      registry: new EvaluatorRegistry(evaluators),
    }).run(plan, context());

    expect(maximum).toBe(2);
    expect(starts.indexOf("safety")).toBeGreaterThan(starts.indexOf("correctness"));
    expect(scorecard.results.map((result) => result.id)).toEqual(
      plan.checks.map((check) => check.id),
    );
    expect(scorecard).toMatchObject({
      grade: "S",
      overallScore: 1,
      passed: true,
      qualityPassed: true,
    });
  });

  it("skips dependent checks and preserves unrelated diagnostics", async () => {
    const checks = dimensionChecks().map((check) =>
      check.id === "safety" ? { ...check, dependsOn: ["correctness"] } : check,
    );
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, (check) =>
        check.id === "correctness" ? failed(check, "Incorrect.") : passed(check),
      ),
    );
    const scorecard = await new EvalScheduler({
      registry: new EvaluatorRegistry(evaluators),
    }).run(createPlan(checks, evaluators), context());

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "correctness", status: "failed" }),
        expect.objectContaining({
          errorCode: "EVAL_DEPENDENCY_FAILED",
          id: "safety",
          status: "not-run",
        }),
        expect.objectContaining({ id: "performance", status: "passed" }),
        expect.objectContaining({ id: "resource", status: "passed" }),
      ]),
    );
    expect(scorecard.passed).toBe(false);
  });

  it("turns evaluator errors and timeouts into bounded error results", async () => {
    const checks = dimensionChecks().map((check) =>
      check.id === "correctness" ? { ...check, timeoutMs: 15 } : check,
    );
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, (check) => {
        if (check.id === "correctness") {
          return new Promise<never>(() => undefined);
        }
        if (check.id === "performance") {
          throw new Error("Bearer secret-value-12345");
        }
        return passed(check);
      }),
    );
    const scorecard = await new EvalScheduler({
      registry: new EvaluatorRegistry(evaluators),
    }).run(createPlan(checks, evaluators), context());

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EVAL_TIMEOUT",
          id: "correctness",
          status: "error",
        }),
        expect.objectContaining({
          errorCode: "EVAL_EVALUATOR_FAILED",
          id: "performance",
          status: "error",
          summary: expect.not.stringContaining("secret-value"),
        }),
      ]),
    );
  });

  it("propagates user cancellation and releases the global run slot", async () => {
    const checks = dimensionChecks();
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, () => new Promise<never>(() => undefined)),
    );
    const limiter = new AsyncSemaphore(1);
    const controller = new AbortController();
    const running = new EvalScheduler({
      registry: new EvaluatorRegistry(evaluators),
      runLimiter: limiter,
    }).run(createPlan(checks, evaluators), context(controller.signal));
    setTimeout(() => controller.abort(new Error("cancelled")), 5);

    await expect(running).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    expect(limiter.activeCount()).toBe(0);
    expect(limiter.pendingCount()).toBe(0);
  });

  it("rejects tampered plans, output drift, and oversized input before execution", async () => {
    const checks = dimensionChecks();
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, (check) => passed(check)),
    );
    const plan = createPlan(checks, evaluators);
    const scheduler = new EvalScheduler({
      registry: new EvaluatorRegistry(evaluators),
    });

    await expect(
      scheduler.run({ ...plan, qualityThreshold: 0.9 }, context()),
    ).rejects.toMatchObject({ code: "EVAL_PLAN_UNSATISFIABLE" });
    await expect(
      scheduler.run(plan, {
        ...context(),
        finalOutputDigest: sha256Text("different"),
      }),
    ).rejects.toMatchObject({ code: "EVAL_ARTIFACT_CHANGED" });
    const oversized = "x".repeat(MAX_EVAL_INPUT_BYTES + 1);
    await expect(
      scheduler.run(plan, {
        ...context(),
        finalOutput: oversized,
        finalOutputDigest: sha256Text(oversized),
      }),
    ).rejects.toMatchObject({ code: "EVAL_INPUT_TOO_LARGE" });
    await expect(scheduler.run(plan, { ...context(), taskId: "other" })).rejects.toMatchObject({
      code: "EVAL_PLAN_UNSATISFIABLE",
    });
    await expect(
      scheduler.run(plan, { ...context(), attemptId: "../invalid" }),
    ).rejects.toMatchObject({ code: "EVAL_PROFILE_INVALID" });
    expect(
      () =>
        new EvalScheduler({
          maxConcurrentRuns: 9,
          registry: new EvaluatorRegistry(evaluators),
        }),
    ).toThrow("between 1 and 8");
  });

  it("marks unavailable observe evaluators not-run and isolates telemetry failures", async () => {
    const checks = dimensionChecks();
    const available = checks
      .slice(1)
      .map((definition) => evaluatorFor(definition, (planned) => passed(planned)));
    const registry = new EvaluatorRegistry(available);
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      profile: { ...profile(checks, 2), mode: "observe" },
      runId: "run",
      taskId: "task",
    });
    const scheduler = new EvalScheduler({
      logger: {
        log: () => {
          throw new Error("log failed");
        },
      },
      metrics: {
        increment: () => {
          throw new Error("metric failed");
        },
        observe: () => {
          throw new Error("metric failed");
        },
      },
      registry,
    });
    const scorecard = await scheduler.run(plan, context());
    expect(scorecard.results[0]).toMatchObject({
      errorCode: "EVAL_PLAN_UNSATISFIABLE",
      status: "not-run",
    });
  });

  it("handles attempt timeout, concurrency groups, and stable evaluator error codes", async () => {
    let active = 0;
    let maximum = 0;
    const checks = dimensionChecks().map((item) => ({
      ...item,
      concurrencyGroup: "provider",
      timeoutMs: 1_000,
    }));
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, async (planned) => {
        if (planned.id === "correctness") {
          throw new EvaluationError("EVAL_PROVIDER_UNAVAILABLE", "Provider unavailable.");
        }
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(2);
        active -= 1;
        return passed(planned);
      }),
    );
    const registry = new EvaluatorRegistry(evaluators);
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      profile: {
        ...profile(checks, 4),
        limits: { ...profile(checks, 4).limits, timeoutMs: 20 },
      },
      runId: "run",
      taskId: "task",
    });
    const scorecard = await new EvalScheduler({
      concurrencyGroupLimits: { provider: 1 },
      registry,
    }).run(plan, context());
    expect(maximum).toBe(1);
    expect(scorecard.results[0]).toMatchObject({
      errorCode: "EVAL_PROVIDER_UNAVAILABLE",
      status: "error",
    });
  });

  it("times out an entire attempt and marks checks that never started as not-run", async () => {
    const checks = dimensionChecks().map((item) => ({
      ...item,
      timeoutMs: 1_000,
    }));
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, () => new Promise<never>(() => undefined)),
    );
    const registry = new EvaluatorRegistry(evaluators);
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      profile: {
        ...profile(checks, 1),
        limits: {
          ...profile(checks, 1).limits,
          timeoutMs: 10,
        },
      },
      runId: "run",
      taskId: "task",
    });
    const scorecard = await new EvalScheduler({ registry }).run(plan, context());

    expect(scorecard.results[0]).toMatchObject({
      errorCode: "EVAL_TIMEOUT",
      status: "error",
    });
    expect(scorecard.results.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EVAL_TIMEOUT",
          status: "not-run",
        }),
      ]),
    );
  });

  it("normalizes coded and empty evaluator failures and creates implicit group limits", async () => {
    const checks = dimensionChecks().map((item) => ({
      ...item,
      concurrencyGroup: "implicit-provider",
      required: item.id !== "resource",
    }));
    const evaluators = checks.map((definition) =>
      evaluatorFor(definition, (planned) => {
        if (planned.id === "correctness") {
          throw Object.assign(new Error("Coded failure."), { code: "EXTERNAL_FAILURE" });
        }
        if (planned.id === "performance") {
          throw "";
        }
        return passed(planned);
      }),
    );
    const registry = new EvaluatorRegistry(evaluators);
    const scorecard = await new EvalScheduler({ registry }).run(
      createPlan(checks, evaluators),
      context(),
    );

    expect(scorecard.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "EXTERNAL_FAILURE",
          id: "correctness",
        }),
        expect.objectContaining({
          errorCode: "EVAL_EVALUATOR_FAILED",
          id: "performance",
          summary: "Evaluator failed.",
        }),
        expect.objectContaining({
          id: "resource",
          required: false,
          status: "passed",
        }),
      ]),
    );
  });

  it("rejects invalid run and concurrency-group limits before scheduling", () => {
    const registry = new EvaluatorRegistry([]);
    for (const maxConcurrentRuns of [0, 1.5]) {
      expect(() => new EvalScheduler({ maxConcurrentRuns, registry })).toThrow(
        "integer between 1 and 8",
      );
    }
    expect(
      () =>
        new EvalScheduler({
          concurrencyGroupLimits: { "../invalid": 1 },
          registry,
        }),
    ).toThrow("ASCII");
    expect(
      () =>
        new EvalScheduler({
          concurrencyGroupLimits: { provider: 0 },
          registry,
        }),
    ).toThrow("integer between 1 and 8");
  });
});

function createPlan(
  checks: readonly EvalCheckDefinition[],
  evaluators: readonly EvalCheckEvaluator[],
  maxConcurrentChecks = 4,
) {
  const registry = new EvaluatorRegistry(evaluators);
  return new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  }).createPlan({
    profile: profile(checks, maxConcurrentChecks),
    runId: "run",
    taskId: "task",
  });
}

function profile(checks: readonly EvalCheckDefinition[], maxConcurrentChecks: number): EvalProfile {
  return {
    checks,
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: "default",
    limits: {
      maxConcurrentChecks,
      maxInputBytes: MAX_EVAL_INPUT_BYTES,
      maxRepairAttempts: 1,
      timeoutMs: 1_000,
    },
    mode: "enforce",
    qualityThreshold: 0.8,
    version: 1,
  };
}

function dimensionChecks(): readonly EvalCheckDefinition[] {
  return [
    check("correctness", "correctness"),
    check("safety", "safety-reliability"),
    check("performance", "performance"),
    check("resource", "resource-efficiency"),
  ];
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

function evaluatorFor(
  definition: EvalCheckDefinition,
  run: (check: PlannedEvalCheck) => Promise<EvalCheckResult> | EvalCheckResult,
): EvalCheckEvaluator {
  return {
    descriptor: {
      capability: definition.capability,
      deterministic: true,
      key: definition.evaluator,
      label: definition.id,
      version: "1.0.0",
    },
    evaluate: run,
  };
}

function passed(check: PlannedEvalCheck) {
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
    status: "passed" as const,
    summary: "Passed.",
    version: 1 as const,
  };
}

function failed(check: PlannedEvalCheck, summary: string) {
  return {
    ...passed(check),
    passed: false,
    retryable: true,
    score: 0,
    status: "failed" as const,
    summary,
  };
}

function context(signal?: AbortSignal): EvalExecutionContext {
  const output = "done";
  return {
    artifacts: [],
    attemptId: "attempt",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow: new AtomicFlowRun({ runId: "run" }).snapshot(),
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    ...(signal !== undefined ? { signal } : {}),
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
