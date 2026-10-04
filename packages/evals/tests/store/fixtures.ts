import { AtomicFlowRun } from "@yiku/atomic-flow";
import {
  createCompletionDecision,
  createDefaultEvalProfile,
  createEvalAttemptRecord,
  createEvalEvidenceIndex,
  DEFAULT_CHECK_EVALUATORS,
  EvalPlanner,
  EvalScheduler,
  EvaluatorRegistry,
  sha256Digest,
  sha256Text,
} from "../../src/index.js";
import type { CompletionDecision, EvalAttemptCommit, EvalPlan } from "../../src/types.js";

export interface StoredFixture {
  readonly commit: EvalAttemptCommit;
  readonly decision: CompletionDecision;
  readonly plan: EvalPlan;
}

export async function storedFixture(): Promise<StoredFixture> {
  const registry = new EvaluatorRegistry(DEFAULT_CHECK_EVALUATORS);
  const plan = new EvalPlanner({
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
    registry,
  }).createPlan({
    profile: createDefaultEvalProfile({
      id: "store-profile",
      maxRepairAttempts: 0,
      mode: "enforce",
      timeoutMs: 1_000,
    }),
    runId: "run",
    taskId: "task",
  });
  const output = "done";
  const scorecard = await new EvalScheduler({ registry }).run(plan, {
    artifacts: [],
    attemptId: "attempt",
    finalOutput: output,
    finalOutputDigest: sha256Text(output),
    flow: completeFlow().snapshot(),
    flowRef: "flow:run",
    operationReceipts: [],
    runId: "run",
    runtimeMetrics: {
      durationMs: 100,
      peakRssBytes: 1024,
    },
    taskId: "task",
    taskSnapshotRef: "task:task",
  });
  const evidenceIndex = createEvalEvidenceIndex("attempt", []);
  const attempt = createEvalAttemptRecord({
    attemptId: "attempt",
    contextDigest: sha256Digest({ context: "fixture" }),
    finishedAt: "2026-08-13T00:00:01.000Z",
    planDigest: plan.digest,
    scorecardDigest: scorecard.digest,
    startedAt: "2026-08-13T00:00:00.000Z",
  });
  const decision = createCompletionDecision({
    action: "accepted",
    attemptId: "attempt",
    reasons: ["All required checks passed."],
    runId: "run",
    taskId: "task",
  });
  return {
    commit: {
      attempt,
      evidenceIndex,
      scorecard,
    },
    decision,
    plan,
  };
}

function completeFlow(): AtomicFlowRun {
  const flow = new AtomicFlowRun({ runId: "run" });
  const root = flow.start({
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    instanceId: "root",
  });
  root.end();
  return flow;
}
