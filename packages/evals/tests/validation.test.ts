import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIMENSION_WEIGHTS,
  EvaluationError,
  evalInputSize,
  MAX_EVAL_INPUT_BYTES,
  sha256Digest,
  sha256Text,
  throwIfEvalAborted,
  validateCheckDefinition,
  validateEvalCheckResult,
  validateEvalPlan,
  validateEvalPlanDigest,
  validateEvalProfile,
} from "../src/index.js";
import type {
  EvalCheckDefinition,
  EvalExecutionContext,
  EvalProfile,
  PlannedEvalCheck,
} from "../src/types.js";
import { requireDigest, requireIdentifier } from "../src/validation.js";

describe("evaluation validation", () => {
  it("accepts a complete profile and rejects invalid weights, limits, and empty enforcement", () => {
    expect(() => validateEvalProfile(profile())).not.toThrow();
    expect(() =>
      validateEvalProfile({
        ...profile(),
        dimensionWeights: {
          ...DEFAULT_DIMENSION_WEIGHTS,
          correctness: 0.4,
        },
      }),
    ).toThrow("sum to 1");
    expect(() =>
      validateEvalProfile({
        ...profile(),
        limits: {
          ...profile().limits,
          maxInputBytes: MAX_EVAL_INPUT_BYTES + 1,
        },
      }),
    ).toThrow("max input bytes");
    expect(() =>
      validateEvalProfile({
        ...profile(),
        checks: [],
      }),
    ).toThrow("at least one check");
  });

  it("enforces check count, unique IDs, dependencies, and acyclic graphs", () => {
    const checks = Array.from({ length: 32 }, (_, index) => check(`check-${index}`, index % 4));
    expect(() =>
      validateEvalProfile({
        ...profile(),
        checks,
      }),
    ).not.toThrow();
    expect(() =>
      validateEvalProfile({
        ...profile(),
        checks: [...checks, check("overflow", 0)],
      }),
    ).toThrow("more than 32");
    expect(() =>
      validateEvalProfile({
        ...profile(),
        checks: [check("duplicate", 0), check("duplicate", 1)],
      }),
    ).toThrow("Duplicate");
    expect(() =>
      validateEvalProfile({
        ...profile(),
        checks: [
          { ...check("first", 0), dependsOn: ["second"] },
          { ...check("second", 1), dependsOn: ["first"] },
          check("third", 2),
          check("fourth", 3),
        ],
      }),
    ).toThrow("cycle");
  });

  it("validates result policy fields, status, scores, and evidence", () => {
    const planned: PlannedEvalCheck = {
      ...check("output", 0),
      ordinal: 0,
      source: "project",
    };
    const valid = {
      dimension: planned.dimension,
      durationMs: 1,
      evaluator: planned.evaluator,
      evidenceRefs: ["evidence:output"],
      id: planned.id,
      label: "Output",
      passed: true,
      required: true,
      retryable: false,
      score: 1,
      severity: planned.severity,
      status: "passed" as const,
      summary: "Output is valid.",
      version: 1 as const,
    };
    expect(() => validateEvalCheckResult(planned, valid)).not.toThrow();
    expect(() =>
      validateEvalCheckResult(planned, {
        ...valid,
        evidenceRefs: [],
      }),
    ).toThrow("evidence");
    expect(() =>
      validateEvalCheckResult(planned, {
        ...valid,
        passed: false,
      }),
    ).toThrow("passed must match");
    expect(() =>
      validateEvalCheckResult(planned, {
        ...valid,
        score: Number.NaN,
      }),
    ).toThrow("between 0 and 1");
  });

  it("measures only bounded context metadata and propagates abort", () => {
    const context = executionContext("评测");
    expect(evalInputSize(context)).toBeGreaterThan(6);
    expect(evalInputSize(context)).toBeLessThan(1_000);

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => throwIfEvalAborted(controller.signal)).toThrow(EvaluationError);
  });

  it("rejects malformed profile, check, and plan fields with stable errors", () => {
    const base = profile();
    for (const invalid of [
      { ...base, version: 2 },
      { ...base, mode: "invalid" },
      { ...base, checks: "invalid" },
      {
        ...base,
        checks: base.checks.filter((item) => item.dimension !== "resource-efficiency"),
      },
      { ...base, limits: { ...base.limits, maxConcurrentChecks: 0 } },
      { ...base, limits: { ...base.limits, maxRepairAttempts: 2 } },
      { ...base, limits: { ...base.limits, timeoutMs: Number.NaN } },
    ]) {
      expect(() => validateEvalProfile(invalid as EvalProfile)).toThrow(EvaluationError);
    }

    const baseCheck = check("invalid-check", 0);
    for (const invalid of [
      { ...baseCheck, id: "../escape" },
      { ...baseCheck, concurrencyGroup: "../group" },
      { ...baseCheck, dimension: "invalid" },
      { ...baseCheck, severity: "invalid" },
      { ...baseCheck, weight: -1 },
      { ...baseCheck, dependsOn: "invalid" },
      { ...baseCheck, dependsOn: [baseCheck.id] },
      { ...baseCheck, dependsOn: ["other", "other"] },
    ]) {
      expect(() => validateCheckDefinition(invalid as EvalCheckDefinition)).toThrow(
        EvaluationError,
      );
    }

    const validPlan = plan();
    const firstPlanCheck = validPlan.checks[0];
    if (firstPlanCheck === undefined) {
      throw new Error("Expected a plan check fixture.");
    }
    for (const invalid of [
      { ...validPlan, attemptBudget: 0 },
      { ...validPlan, createdAt: "invalid" },
      {
        ...validPlan,
        checks: [{ ...firstPlanCheck, ordinal: -1 }, ...validPlan.checks.slice(1)],
      },
      {
        ...validPlan,
        checks: validPlan.checks.map((item) => ({ ...item, ordinal: 0 })),
      },
    ]) {
      expect(() => validateEvalPlan(invalid as typeof validPlan)).toThrow(EvaluationError);
    }
    expect(() =>
      validateEvalPlanDigest({
        ...validPlan,
        qualityThreshold: 0.9,
      }),
    ).toThrow("digest");
    expect(() => requireIdentifier("", "ID")).toThrow("ASCII");
    expect(() => requireDigest("invalid", "Digest")).toThrow("SHA-256");
  });

  it("rejects every inconsistent result field and invalid resource usage", () => {
    const planned: PlannedEvalCheck = {
      ...check("result", 0),
      ordinal: 0,
      source: "project",
    };
    const valid = validResult(planned);
    for (const invalid of [
      { ...valid, version: 2 },
      { ...valid, id: "other" },
      { ...valid, evaluator: "other" },
      { ...valid, dimension: "performance" },
      { ...valid, required: false },
      { ...valid, severity: "warning" },
      { ...valid, status: "invalid" },
      { ...valid, durationMs: -1 },
      { ...valid, label: "" },
      { ...valid, summary: "" },
      { ...valid, feedback: "" },
      { ...valid, status: "error", passed: false, errorCode: "" },
      { ...valid, evidenceRefs: "invalid" },
      { ...valid, evidenceRefs: ["same", "same"] },
      { ...valid, resourceUsage: { cpuMs: -1 } },
    ]) {
      expect(() => validateEvalCheckResult(planned, invalid as typeof valid)).toThrow(
        EvaluationError,
      );
    }
  });
});

function plan() {
  const checks = profile().checks.map((item, ordinal) => ({
    ...item,
    ordinal,
    source: "project" as const,
  }));
  const semantic = {
    attemptBudget: 2 as const,
    checks,
    createdAt: "2026-08-13T00:00:00.000Z",
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    limits: profile().limits,
    mode: "enforce" as const,
    profileId: "profile",
    qualityThreshold: 0.8,
    runId: "run",
    taskId: "task",
    version: 1 as const,
  };
  return {
    ...semantic,
    digest: sha256Digest(semantic),
  };
}

function validResult(planned: PlannedEvalCheck) {
  return {
    dimension: planned.dimension,
    durationMs: 1,
    evaluator: planned.evaluator,
    evidenceRefs: ["evidence:result"],
    id: planned.id,
    label: "Result",
    passed: true,
    required: planned.required,
    retryable: false,
    score: 1,
    severity: planned.severity,
    status: "passed" as const,
    summary: "Passed.",
    version: 1 as const,
  };
}

function profile(): EvalProfile {
  return {
    checks: [
      check("correctness", 0),
      check("safety", 1),
      check("performance", 2),
      check("resource", 3),
    ],
    dimensionWeights: DEFAULT_DIMENSION_WEIGHTS,
    id: "default-profile",
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

function check(id: string, dimensionIndex: number): EvalCheckDefinition {
  const dimensions = [
    "correctness",
    "safety-reliability",
    "performance",
    "resource-efficiency",
  ] as const;
  return {
    capability: `capability-${id}`,
    config: {},
    dependsOn: [],
    dimension: dimensions[dimensionIndex] ?? "correctness",
    evaluator: `evaluator-${id}`,
    evidenceRequired: true,
    id,
    required: true,
    severity: dimensionIndex === 1 ? "blocker" : "error",
    timeoutMs: 1_000,
    weight: 1,
  };
}

function executionContext(output: string): EvalExecutionContext {
  const flow = new AtomicFlowRun({ runId: "run" }).snapshot();
  return {
    artifacts: [],
    attemptId: "attempt-1",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow,
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
}
