import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import {
  compareEvalBaseline,
  createCompletionDecision,
  createEvalBaseline,
  DEFAULT_CHECK_EVALUATORS,
  EvalScheduler,
  EvaluatorRegistry,
  sha256Digest,
  sha256Text,
  validateEvalBaseline,
} from "../src/index.js";
import { storedFixture } from "./store/fixtures.js";

describe("evaluation baselines", () => {
  it("creates an approved baseline and compares equivalent scorecards", async () => {
    const fixture = await storedFixture();
    const baseline = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:00.000Z",
      approvedBy: "ci",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: Object.fromEntries(
        DEFAULT_CHECK_EVALUATORS.map((evaluator) => [
          evaluator.descriptor.key,
          evaluator.descriptor.version,
        ]),
      ),
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "default-suite",
    });

    expect(compareEvalBaseline(baseline, fixture.commit.scorecard)).toMatchObject({
      passed: true,
      regressions: [],
      scoreDelta: 0,
    });
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  it("detects hard-gate, dimension, check-status, and overall regressions", async () => {
    const fixture = await storedFixture();
    const baseline = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:00.000Z",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: {},
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "default-suite",
    });
    const current = await failingScorecard(fixture.plan);
    const comparison = compareEvalBaseline(baseline, current);

    expect(comparison.passed).toBe(false);
    expect(comparison.scoreDelta).toBeLessThan(0);
    expect(comparison.regressions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("hard gate"),
        expect.stringContaining("Overall score"),
        expect.stringContaining("changed from passed"),
      ]),
    );
  });

  it("rejects non-accepted inputs, invalid tolerances, and tampered baselines", async () => {
    const fixture = await storedFixture();
    const rejected = createCompletionDecision({
      action: "rejected",
      attemptId: "attempt",
      reasons: ["Rejected."],
      runId: "run",
      taskId: "task",
    });
    expect(() =>
      createEvalBaseline({
        approvedAt: "2026-08-13T00:00:00.000Z",
        baselineVersion: "1.0.0",
        decision: rejected,
        evaluatorVersions: {},
        profileId: fixture.plan.profileId,
        runtimeDigest: sha256Digest({ node: process.version }),
        scorecard: fixture.commit.scorecard,
        suiteId: "default-suite",
      }),
    ).toThrow("Only accepted");

    const baseline = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:00.000Z",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: {},
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "default-suite",
    });
    expect(() =>
      compareEvalBaseline(baseline, fixture.commit.scorecard, {
        scoreTolerance: -1,
      }),
    ).toThrow("between 0 and 1");
    expect(() =>
      compareEvalBaseline(
        {
          ...baseline,
          overallScore: 0,
        },
        fixture.commit.scorecard,
      ),
    ).toThrow("digest");
  });

  it("validates baseline metadata, attempt identity, and tolerance boundaries", async () => {
    const fixture = await storedFixture();
    const create = (overrides: Partial<Parameters<typeof createEvalBaseline>[0]> = {}) =>
      createEvalBaseline({
        approvedAt: "2026-08-13T00:00:00.000Z",
        baselineVersion: "1.0.0",
        decision: fixture.decision,
        evaluatorVersions: {},
        profileId: fixture.plan.profileId,
        runtimeDigest: sha256Digest({ node: process.version }),
        scorecard: fixture.commit.scorecard,
        suiteId: "default-suite",
        ...overrides,
      });

    expect(() => create({ approvedAt: "invalid" })).toThrow("valid date");
    expect(() => create({ approvedBy: " " })).toThrow("non-empty");
    expect(() =>
      create({
        decision: createCompletionDecision({
          action: "accepted",
          attemptId: "other-attempt",
          reasons: ["Accepted."],
          runId: "run",
          taskId: "task",
        }),
      }),
    ).toThrow("same attempt");
    expect(() => create({ evaluatorVersions: { "../invalid": "1.0.0" } })).toThrow();

    const baseline = create();
    for (const scoreTolerance of [Number.NaN, 2]) {
      expect(() =>
        compareEvalBaseline(baseline, fixture.commit.scorecard, { scoreTolerance }),
      ).toThrow("between 0 and 1");
    }
    expect(() => validateEvalBaseline({ ...baseline, version: 2 as 1 })).toThrow("Unsupported");
  });

  it("reports baseline checks missing from the current evaluator set", async () => {
    const fixture = await storedFixture();
    const baseline = createEvalBaseline({
      approvedAt: "2026-08-13T00:00:00.000Z",
      baselineVersion: "1.0.0",
      decision: fixture.decision,
      evaluatorVersions: {},
      profileId: fixture.plan.profileId,
      runtimeDigest: sha256Digest({ node: process.version }),
      scorecard: fixture.commit.scorecard,
      suiteId: "default-suite",
    });
    const checks = [
      ...baseline.checks.map((check, index) =>
        index === 0
          ? {
              id: check.id,
              status: check.status,
            }
          : check,
      ),
      {
        id: "removed-check",
        status: "passed" as const,
      },
    ];
    const semantic = {
      approvedAt: baseline.approvedAt,
      baselineVersion: baseline.baselineVersion,
      checks,
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
    const comparison = compareEvalBaseline(
      {
        ...semantic,
        digest: sha256Digest(semantic),
      },
      fixture.commit.scorecard,
    );

    expect(comparison.regressions).toContain("Baseline check removed-check is missing.");
  });
});

async function failingScorecard(plan: Awaited<ReturnType<typeof storedFixture>>["plan"]) {
  const flow = new AtomicFlowRun({ runId: "run" });
  const root = flow.start({
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
  });
  root.end();
  const memory = flow.start({
    atom: {
      key: "memory.write",
      kind: "memory",
      label: "Memory",
      level: "runtime",
    },
    payload: {
      summary: "Bearer secret-value-123456",
    },
  });
  memory.end();
  const output = "done";
  return new EvalScheduler({
    registry: new EvaluatorRegistry(DEFAULT_CHECK_EVALUATORS),
  }).run(plan, {
    artifacts: [],
    attemptId: "attempt-regression",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow: flow.snapshot(),
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    runtimeMetrics: {
      durationMs: 900_000,
      peakRssBytes: 384 * 1024 * 1024,
    },
    taskId: "task",
    taskSnapshotRef: "task:task",
  });
}
