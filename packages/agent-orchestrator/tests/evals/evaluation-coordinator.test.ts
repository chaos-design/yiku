import { AtomicFlowRun } from "@yiku/atomic-flow";
import {
  type CompletionDecision,
  createDefaultEvalProfile,
  createEvaluationScorecard,
  DEFAULT_CHECK_EVALUATORS,
  type EvalAttemptCommit,
  type EvalPlan,
  EvalPlanner,
  type EvalResultStore,
  type EvalRunQuery,
  type EvalRunSummary,
  EvalScheduler,
  type EvalStoredAttempt,
  EvaluationError,
  EvaluatorRegistry,
} from "@yiku/evals";
import { describe, expect, it, vi } from "vitest";
import {
  EvaluationCoordinator,
  EvaluationGateError,
} from "../../src/evals/evaluation-coordinator.js";

describe("EvaluationCoordinator", () => {
  it("persists an accepted attempt and emits structured evaluation atoms", async () => {
    const fixture = coordinatorFixture();
    const outcome = await fixture.coordinator.run(input(fixture.flow, "done"));

    expect(outcome).toMatchObject({
      attempts: [{ decision: { action: "accepted" } }],
      decision: { action: "accepted" },
      finalOutput: "done",
    });
    expect(fixture.store.operations).toEqual(["plan", "attempt", "decision"]);
    expect(fixture.store.attempts[0]?.evidenceIndex.evidence.length).toBeGreaterThan(0);
    expect(fixture.flow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "eval.trigger",
        "eval.attempt",
        "eval.scorecard",
        "eval.decision",
        "eval.gate",
      ]),
    );
  });

  it("runs one repair attempt with fresh output and full reevaluation", async () => {
    const fixture = coordinatorFixture();
    const repair = vi.fn(async () => ({
      artifacts: [],
      finalOutput: "fixed",
      flow: fixture.flow.snapshot(),
      operationReceipts: [],
      runtimeMetrics: {
        durationMs: 100,
        peakRssBytes: 1024,
      },
    }));
    const outcome = await fixture.coordinator.run({
      ...input(fixture.flow, " "),
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(outcome.finalOutput).toBe("fixed");
    expect(outcome.attempts.map((attempt) => attempt.decision.action)).toEqual([
      "retry",
      "accepted",
    ]);
    expect(fixture.store.operations).toEqual([
      "plan",
      "attempt",
      "decision",
      "attempt",
      "decision",
    ]);
  });

  it("does not repair observe-mode evaluations", async () => {
    const fixture = coordinatorFixture("observe");
    const repair = vi.fn();
    const outcome = await fixture.coordinator.run({
      ...input(fixture.flow, " "),
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(outcome.decision.action).toBe("rejected");
    expect(outcome.attempts).toHaveLength(1);
  });

  it("propagates store failures without emitting a successful gate", async () => {
    const fixture = coordinatorFixture();
    fixture.store.writeAttemptError = new EvaluationError(
      "EVAL_STORE_UNAVAILABLE",
      "Store unavailable.",
    );

    await expect(fixture.coordinator.run(input(fixture.flow, "done"))).rejects.toMatchObject({
      code: "EVAL_STORE_UNAVAILABLE",
    });
    expect(
      fixture.flow
        .snapshot()
        .events.some((event) => event.atom.key === "eval.gate" && event.phase === "end"),
    ).toBe(false);
  });

  it("exposes a gate error carrying the complete outcome", async () => {
    const fixture = coordinatorFixture();
    const outcome = await fixture.coordinator.run(input(fixture.flow, " "));
    const error = new EvaluationGateError(outcome);

    expect(error.outcome).toBe(outcome);
    expect(error.message).toContain("rejected");
  });

  it("projects mixed evaluator states and every evidence type", async () => {
    const fixture = coordinatorFixture();
    const scheduler = {
      async run(plan: EvalPlan, context: Parameters<EvalScheduler["run"]>[1]) {
        const references = [
          "artifact:command",
          "research:citation",
          "resource:attempt:cpu",
          "output:custom",
          "custom:artifact",
        ];
        const results = plan.checks.map((check, index) => {
          const status = index === 0 ? "error" : index === 1 ? "not-run" : "passed";
          const result = {
            dimension: check.dimension,
            durationMs: 1,
            ...(status === "passed"
              ? {}
              : {
                  errorCode:
                    status === "error" ? "EVAL_PROVIDER_UNAVAILABLE" : "EVAL_DEPENDENCY_FAILED",
                }),
            evaluator: check.evaluator,
            evidenceRefs: [references[index % references.length] as string],
            id: check.id,
            label: check.id,
            passed: status === "passed",
            required: check.required,
            retryable: status === "error",
            score: status === "passed" ? 1 : 0,
            severity: check.severity,
            status,
            summary: status,
            version: 1 as const,
          };
          if (index === 4) {
            const { score: _score, ...withoutScore } = result;
            return withoutScore;
          }
          return result;
        });
        return createEvaluationScorecard(plan, context, results, 1);
      },
    } as EvalScheduler;
    const coordinator = new EvaluationCoordinator({
      planner: fixture.planner,
      profile: fixture.profile,
      scheduler,
      store: fixture.store,
    });
    const outcome = await coordinator.run({
      ...input(fixture.flow, "done"),
      artifacts: [
        artifact("command", "command-result"),
        artifact("research", "research-report"),
        artifact("file", "file-change"),
      ],
      researchClaimManifest: {
        claims: [],
        digest: "a".repeat(64),
        reportDigest: "b".repeat(64),
        version: 1,
      },
      runtimeMetrics: undefined,
      signal: new AbortController().signal,
    });

    expect(outcome.decision.action).toBe("needs-review");
    expect(fixture.store.attempts[0]?.evidenceIndex.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "command" }),
        expect.objectContaining({ type: "research" }),
        expect.objectContaining({ type: "resource" }),
        expect.objectContaining({ type: "artifact" }),
        expect.objectContaining({ type: "output" }),
        expect.objectContaining({ type: "flow" }),
      ]),
    );

    const untraced = coordinatorFixture();
    await expect(
      untraced.coordinator.run({
        ...input(untraced.flow, "done"),
        atomicFlow: undefined,
        runtimeMetrics: undefined,
      }),
    ).resolves.toMatchObject({
      attempts: [expect.any(Object)],
    });
  });

  it("marks trace atoms failed for non-Error scheduler failures", async () => {
    const fixture = coordinatorFixture();
    const coordinator = new EvaluationCoordinator({
      planner: fixture.planner,
      profile: fixture.profile,
      scheduler: {
        run: async () => {
          throw "scheduler failed";
        },
      } as unknown as EvalScheduler,
      store: fixture.store,
    });

    await expect(coordinator.run(input(fixture.flow, "done"))).rejects.toBe("scheduler failed");
    const failures = fixture.flow
      .snapshot()
      .events.filter((event) => event.phase === "error" && event.atom.key.startsWith("eval."));
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          atom: expect.objectContaining({ key: "eval.attempt" }),
          payload: expect.objectContaining({ code: "EVAL_RUNNER_FAILED" }),
        }),
        expect.objectContaining({
          atom: expect.objectContaining({ key: "eval.trigger" }),
          payload: expect.objectContaining({ code: "EVAL_RUNNER_FAILED" }),
        }),
      ]),
    );
  });

  it("does not rewrite a finished trace when the repair handler fails", async () => {
    const fixture = coordinatorFixture();
    await expect(
      fixture.coordinator.run({
        ...input(fixture.flow, " "),
        repair: async () => {
          throw new Error("repair failed");
        },
      }),
    ).rejects.toThrow("repair failed");
    const attemptErrors = fixture.flow
      .snapshot()
      .events.filter((event) => event.atom.key === "eval.attempt" && event.phase === "error");
    expect(attemptErrors).toEqual([]);
  });
});

function coordinatorFixture(mode: "enforce" | "observe" = "enforce") {
  const registry = new EvaluatorRegistry(DEFAULT_CHECK_EVALUATORS);
  const store = new MemoryEvalStore();
  const flow = completedFlow();
  let id = 0;
  let now = 0;
  const planner = new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  });
  const profile = createDefaultEvalProfile({
    maxRepairAttempts: 1,
    mode,
    timeoutMs: 1_000,
  });
  const coordinator = new EvaluationCoordinator({
    clock: () => new Date(Date.UTC(2026, 7, 13, 0, 0, now++)),
    idGenerator: () => `attempt-${++id}`,
    planner,
    profile,
    scheduler: new EvalScheduler({ registry }),
    store,
  });
  return { coordinator, flow, planner, profile, store };
}

function input(flow: AtomicFlowRun, finalOutput: string) {
  return {
    atomicFlow: flow,
    finalOutput,
    flow: flow.snapshot(),
    flowRef: "flow:run",
    runId: "run",
    runtimeMetrics: {
      durationMs: 100,
      peakRssBytes: 1024,
    },
    taskId: "task",
    taskSnapshotRef: "task:task",
  };
}

function completedFlow(): AtomicFlowRun {
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
  return flow;
}

function artifact(id: string, kind: "command-result" | "file-change" | "research-report") {
  return {
    digest: "d".repeat(64),
    id,
    kind,
    metadata: {},
    sizeBytes: 1,
    storageRef: `artifact:${id}`,
  } as const;
}

class MemoryEvalStore implements EvalResultStore {
  public readonly attempts: EvalAttemptCommit[] = [];
  public readonly decisions: CompletionDecision[] = [];
  public readonly operations: string[] = [];
  public plan: EvalPlan | undefined;
  public writeAttemptError: Error | undefined;

  public async initialize(): Promise<void> {}

  public async listRuns(_query: EvalRunQuery): Promise<readonly EvalRunSummary[]> {
    return [];
  }

  public async readAttempt(
    _runId: string,
    attemptId: string,
  ): Promise<EvalStoredAttempt | undefined> {
    const commit = this.attempts.find((candidate) => candidate.attempt.attemptId === attemptId);
    if (commit === undefined) {
      return undefined;
    }
    const decision = this.decisions.find((candidate) => candidate.attemptId === attemptId);
    return {
      ...commit,
      ...(decision !== undefined ? { decision } : {}),
    };
  }

  public async writeAttempt(commit: EvalAttemptCommit): Promise<void> {
    if (this.writeAttemptError !== undefined) {
      throw this.writeAttemptError;
    }
    this.operations.push("attempt");
    this.attempts.push(commit);
  }

  public async writeDecision(decision: CompletionDecision): Promise<void> {
    this.operations.push("decision");
    this.decisions.push(decision);
  }

  public async writePlan(plan: EvalPlan): Promise<void> {
    this.operations.push("plan");
    this.plan = plan;
  }
}
