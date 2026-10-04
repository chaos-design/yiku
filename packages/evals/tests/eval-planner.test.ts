import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIMENSION_WEIGHTS,
  EvalPlanner,
  EvaluationError,
  EvaluatorRegistry,
  MAX_EVAL_INPUT_BYTES,
} from "../src/index.js";
import type { EvalCheckDefinition, EvalCheckEvaluator, EvalProfile } from "../src/types.js";

describe("EvalPlanner", () => {
  it("creates a stable immutable plan in source-priority order", () => {
    const projectChecks = dimensionChecks();
    const userCheck = check("user-check", "correctness");
    const factoryCheck = check("factory-check", "performance");
    const registry = new EvaluatorRegistry(
      [...projectChecks, userCheck, factoryCheck].map(evaluatorFor),
    );
    const planner = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    });
    const input = {
      agentFactoryChecks: [factoryCheck],
      profile: profile(projectChecks),
      runId: "run-1",
      taskId: "task-1",
      userAcceptanceChecks: [userCheck],
    };
    const first = planner.createPlan(input);
    const second = planner.createPlan(input);

    expect(first.digest).toBe(second.digest);
    expect(first.attemptBudget).toBe(2);
    expect(first.checks.map(({ id, ordinal, source }) => ({ id, ordinal, source }))).toEqual([
      { id: "correctness", ordinal: 0, source: "project" },
      { id: "safety", ordinal: 1, source: "project" },
      { id: "performance", ordinal: 2, source: "project" },
      { id: "resource", ordinal: 3, source: "project" },
      { id: "user-check", ordinal: 4, source: "user-acceptance" },
      { id: "factory-check", ordinal: 5, source: "agent-factory" },
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.checks)).toBe(true);
  });

  it("rejects lower-priority redefinitions and capability mismatches", () => {
    const checks = dimensionChecks();
    const firstCheck = checks[0];
    if (firstCheck === undefined) {
      throw new Error("Expected a correctness check fixture.");
    }
    const registry = new EvaluatorRegistry(checks.map(evaluatorFor));
    const planner = new EvalPlanner({ registry });

    expect(() =>
      planner.createPlan({
        profile: profile(checks),
        runId: "run",
        taskId: "task",
        userAcceptanceChecks: [{ ...firstCheck, timeoutMs: 2_000 }],
      }),
    ).toThrow("redefine");

    const mismatchRegistry = new EvaluatorRegistry([
      {
        ...evaluatorFor(firstCheck),
        descriptor: {
          ...evaluatorFor(firstCheck).descriptor,
          capability: "different-capability",
        },
      },
      ...checks.slice(1).map(evaluatorFor),
    ]);
    expect(() =>
      new EvalPlanner({ registry: mismatchRegistry }).createPlan({
        profile: profile(checks),
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("provides capability");
  });

  it("rejects missing required evaluators in enforce mode and permits observe plans", () => {
    const checks = dimensionChecks();
    const planner = new EvalPlanner({ registry: new EvaluatorRegistry() });
    expect(() =>
      planner.createPlan({
        profile: profile(checks),
        runId: "run",
        taskId: "task",
      }),
    ).toThrow(EvaluationError);

    expect(
      planner.createPlan({
        profile: {
          ...profile(checks),
          mode: "observe",
        },
        runId: "run",
        taskId: "task",
      }).checks,
    ).toHaveLength(4);
  });

  it("uses managed policy and prevents project checks from changing it", () => {
    const managedChecks = dimensionChecks("managed");
    const projectChecks = dimensionChecks("project");
    const registry = new EvaluatorRegistry([...managedChecks, ...projectChecks].map(evaluatorFor));
    const plan = new EvalPlanner({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      registry,
    }).createPlan({
      managedProfile: {
        ...profile(managedChecks),
        id: "managed-profile",
        limits: {
          ...profile(managedChecks).limits,
          maxRepairAttempts: 0,
        },
      },
      profile: profile(projectChecks),
      runId: "run",
      taskId: "task",
    });

    expect(plan.profileId).toBe("managed-profile");
    expect(plan.attemptBudget).toBe(1);
    expect(plan.checks.slice(0, 4).every((item) => item.source === "managed")).toBe(true);
  });

  it("accepts identical lower-priority checks, optional groups, and suggested checks", () => {
    const checks = dimensionChecks();
    const first = checks[0];
    if (first === undefined) {
      throw new Error("Expected a check fixture.");
    }
    const grouped = {
      ...first,
      concurrencyGroup: "provider",
    };
    const suggested = check("suggested", "correctness");
    const registry = new EvaluatorRegistry(
      [grouped, ...checks.slice(1), suggested].map(evaluatorFor),
    );
    const plan = new EvalPlanner({ registry }).createPlan({
      agentSuggestedChecks: [suggested],
      profile: profile([grouped, ...checks.slice(1)]),
      runId: "run",
      taskId: "task",
      userAcceptanceChecks: [grouped],
    });

    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          concurrencyGroup: "provider",
          id: grouped.id,
          source: "project",
        }),
        expect.objectContaining({
          id: "suggested",
          source: "agent-suggestion",
        }),
      ]),
    );
  });

  it("rejects clocks that do not produce an ISO date", () => {
    const checks = dimensionChecks();
    const planner = new EvalPlanner({
      clock: () =>
        ({
          toISOString: () => "invalid",
        }) as Date,
      registry: new EvaluatorRegistry(checks.map(evaluatorFor)),
    });
    expect(() =>
      planner.createPlan({
        profile: profile(checks),
        runId: "run",
        taskId: "task",
      }),
    ).toThrow("invalid date");
  });
});

function dimensionChecks(prefix = ""): readonly EvalCheckDefinition[] {
  const name = (value: string) => (prefix ? `${prefix}-${value}` : value);
  return [
    check(name("correctness"), "correctness"),
    check(name("safety"), "safety-reliability"),
    check(name("performance"), "performance"),
    check(name("resource"), "resource-efficiency"),
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
    timeoutMs: 1_000,
    weight: 1,
  };
}

function profile(checks: readonly EvalCheckDefinition[]): EvalProfile {
  return {
    checks,
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: "project-profile",
    limits: {
      maxConcurrentChecks: 4,
      maxInputBytes: MAX_EVAL_INPUT_BYTES,
      maxRepairAttempts: 1,
      timeoutMs: 10_000,
    },
    mode: "enforce",
    qualityThreshold: 0.8,
    version: 1,
  };
}

function evaluatorFor(checkDefinition: EvalCheckDefinition): EvalCheckEvaluator {
  return {
    descriptor: {
      capability: checkDefinition.capability,
      deterministic: true,
      key: checkDefinition.evaluator,
      label: checkDefinition.id,
      version: "1.0.0",
    },
    evaluate(check) {
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
    },
  };
}
