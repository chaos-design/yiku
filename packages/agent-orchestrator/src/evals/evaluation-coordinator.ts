import { randomUUID } from "node:crypto";
import type { AtomicFlowRun, AtomicFlowSnapshot } from "@yiku/atomic-flow";
import {
  type AgentArtifactRef,
  type CompletionDecision,
  createEvalAttemptRecord,
  createEvalEvidenceIndex,
  EVAL_ATOMS,
  type EvalEvidence,
  type EvalExecutionContext,
  type EvalPlan,
  type EvalPlanner,
  type EvalProfile,
  type EvalResultStore,
  type EvalRuntimeMetrics,
  type EvalScheduler,
  type EvaluationScorecard,
  evaluatorAtom,
  type OperationReceipt,
  type ResearchClaimManifest,
  sha256Digest,
  sha256Text,
} from "@yiku/evals";
import { CompletionPolicy } from "./completion-policy.js";

export interface EvaluationRepairInput {
  readonly decision: CompletionDecision;
  readonly output: string;
  readonly repairAttempt: number;
}

export interface EvaluationRepairResult {
  readonly artifacts?: readonly AgentArtifactRef[] | undefined;
  readonly finalOutput: string;
  readonly flow: AtomicFlowSnapshot;
  readonly operationReceipts?: readonly OperationReceipt[] | undefined;
  readonly researchClaimManifest?: ResearchClaimManifest | undefined;
  readonly runtimeMetrics?: EvalRuntimeMetrics | undefined;
}

export type EvaluationRepairHandler = (
  input: EvaluationRepairInput,
) => Promise<EvaluationRepairResult>;

export interface EvaluationCoordinatorOptions {
  readonly clock?: (() => Date) | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly planner: EvalPlanner;
  readonly policy?: CompletionPolicy | undefined;
  readonly profile: EvalProfile;
  readonly scheduler: EvalScheduler;
  readonly store: EvalResultStore;
}

export interface EvaluationCoordinatorInput {
  readonly artifacts?: readonly AgentArtifactRef[] | undefined;
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly finalOutput: string;
  readonly flow: AtomicFlowSnapshot;
  readonly flowRef: string;
  readonly operationReceipts?: readonly OperationReceipt[] | undefined;
  readonly repair?: EvaluationRepairHandler | undefined;
  readonly researchClaimManifest?: ResearchClaimManifest | undefined;
  readonly runId: string;
  readonly runtimeMetrics?: EvalRuntimeMetrics | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly taskId: string;
  readonly taskSnapshotRef: string;
}

export interface EvaluationAttemptOutcome {
  readonly attemptId: string;
  readonly decision: CompletionDecision;
  readonly scorecard: EvaluationScorecard;
}

export interface EvaluationOutcome {
  readonly attempts: readonly EvaluationAttemptOutcome[];
  readonly decision: CompletionDecision;
  readonly finalOutput: string;
  readonly plan: EvalPlan;
  readonly scorecard: EvaluationScorecard;
  readonly storeRef: string;
}

export class EvaluationGateError extends Error {
  public override readonly name = "EvaluationGateError";

  public constructor(public readonly outcome: EvaluationOutcome) {
    super(`Evaluation ${outcome.decision.action}: ${outcome.decision.reasons.join("; ")}.`);
  }
}

export class EvaluationCoordinator {
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly options: EvaluationCoordinatorOptions;
  private readonly policy: CompletionPolicy;

  public constructor(options: EvaluationCoordinatorOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.policy = options.policy ?? new CompletionPolicy();
  }

  public async run(input: EvaluationCoordinatorInput): Promise<EvaluationOutcome> {
    const plan = this.options.planner.createPlan({
      profile: this.options.profile,
      runId: input.runId,
      taskId: input.taskId,
    });
    await this.options.store.writePlan(plan);
    let current: EvaluationRepairResult = {
      artifacts: input.artifacts ?? [],
      finalOutput: input.finalOutput,
      flow: input.flow,
      operationReceipts: input.operationReceipts ?? [],
      ...(input.researchClaimManifest !== undefined
        ? { researchClaimManifest: input.researchClaimManifest }
        : {}),
      ...(input.runtimeMetrics !== undefined ? { runtimeMetrics: input.runtimeMetrics } : {}),
    };
    const attempts: EvaluationAttemptOutcome[] = [];
    let repairAttemptsUsed = 0;

    for (;;) {
      const attemptId = this.idGenerator();
      const startedAt = this.clock().toISOString();
      const context = createContext(input, current, attemptId);
      const trace = startEvaluationTrace(input.atomicFlow, attemptId, attempts.length);
      let traceFinished = false;
      try {
        const scorecard = await this.options.scheduler.run(plan, context);
        const finishedAt = this.clock().toISOString();
        const evidenceIndex = createEvalEvidenceIndex(attemptId, evidenceFor(context, scorecard));
        const attempt = createEvalAttemptRecord({
          attemptId,
          contextDigest: contextDigest(context),
          finishedAt,
          planDigest: plan.digest,
          scorecardDigest: scorecard.digest,
          startedAt,
        });
        await this.options.store.writeAttempt({
          attempt,
          evidenceIndex,
          scorecard,
        });
        emitResults(trace, scorecard);
        const decision = this.policy.decide({
          canRepair: input.repair !== undefined && plan.mode === "enforce",
          maxRepairAttempts: this.options.profile.limits.maxRepairAttempts,
          operationReceipts: context.operationReceipts,
          repairAttemptsUsed,
          scorecard,
        });
        await this.options.store.writeDecision(decision);
        finishEvaluationTrace(trace, scorecard, decision);
        traceFinished = true;
        attempts.push(
          Object.freeze({
            attemptId,
            decision,
            scorecard,
          }),
        );

        if (decision.action !== "retry" || input.repair === undefined) {
          return freezeOutcome(plan, attempts, current.finalOutput);
        }
        repairAttemptsUsed += 1;
        current = await input.repair({
          decision,
          output: current.finalOutput,
          repairAttempt: repairAttemptsUsed,
        });
      } catch (error) {
        if (!traceFinished) {
          trace?.attempt.fail({
            code: errorCode(error),
            summary: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          });
          trace?.trigger.fail({
            code: errorCode(error),
            summary: "Evaluation attempt failed.",
          });
        }
        throw error;
      }
    }
  }
}

function createContext(
  input: EvaluationCoordinatorInput,
  current: EvaluationRepairResult,
  attemptId: string,
): EvalExecutionContext {
  return Object.freeze({
    artifacts: Object.freeze([...(current.artifacts ?? [])]),
    attemptId,
    finalOutput: current.finalOutput,
    finalOutputDigest: sha256Text(current.finalOutput),
    flow: current.flow,
    flowRef: input.flowRef,
    operationReceipts: Object.freeze([...(current.operationReceipts ?? [])]),
    ...(current.researchClaimManifest !== undefined
      ? { researchClaimManifest: current.researchClaimManifest }
      : {}),
    runId: input.runId,
    ...(current.runtimeMetrics !== undefined ? { runtimeMetrics: current.runtimeMetrics } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    taskId: input.taskId,
    taskSnapshotRef: input.taskSnapshotRef,
  });
}

function contextDigest(context: EvalExecutionContext): string {
  return sha256Digest({
    artifacts: context.artifacts.map((artifact) => ({
      digest: artifact.digest,
      id: artifact.id,
      storageRef: artifact.storageRef,
    })),
    attemptId: context.attemptId,
    finalOutputDigest: context.finalOutputDigest,
    flowDigest: sha256Digest(context.flow),
    flowRef: context.flowRef,
    operationReceipts: context.operationReceipts,
    researchClaimManifestDigest: context.researchClaimManifest?.digest ?? null,
    runId: context.runId,
    runtimeMetrics: context.runtimeMetrics ?? null,
    taskId: context.taskId,
    taskSnapshotRef: context.taskSnapshotRef,
  });
}

function evidenceFor(
  context: EvalExecutionContext,
  scorecard: EvaluationScorecard,
): readonly EvalEvidence[] {
  const byRef = new Map<string, EvalEvidence>();
  for (const artifact of context.artifacts) {
    byRef.set(
      artifact.storageRef,
      Object.freeze({
        digest: artifact.digest,
        id: artifact.id,
        metadata: artifact.metadata,
        ref: artifact.storageRef,
        summary: `${artifact.kind} ${artifact.storageRef}`.slice(0, 2_000),
        type:
          artifact.kind === "command-result"
            ? "command"
            : artifact.kind.startsWith("research-")
              ? "research"
              : "artifact",
        version: 1,
      }),
    );
  }
  const builtIn = [
    {
      digest: context.finalOutputDigest,
      ref: `output:sha256:${context.finalOutputDigest}`,
      type: "output" as const,
    },
    {
      digest: sha256Digest(context.flow),
      ref: context.flowRef,
      type: "flow" as const,
    },
  ];
  for (const item of builtIn) {
    byRef.set(
      item.ref,
      Object.freeze({
        digest: item.digest,
        id: `evidence-${sha256Text(item.ref)}`,
        metadata: Object.freeze({}),
        ref: item.ref,
        summary: item.ref,
        type: item.type,
        version: 1,
      }),
    );
  }
  for (const reference of scorecard.results.flatMap((result) => result.evidenceRefs)) {
    if (byRef.has(reference)) {
      continue;
    }
    byRef.set(
      reference,
      Object.freeze({
        digest: sha256Text(reference),
        id: `evidence-${sha256Text(reference)}`,
        metadata: Object.freeze({}),
        ref: reference,
        summary: reference.slice(0, 2_000),
        type: evidenceType(reference),
        version: 1,
      }),
    );
  }
  return Object.freeze(
    [...byRef.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
  );
}

function evidenceType(reference: string): EvalEvidence["type"] {
  if (reference.startsWith("command:")) {
    return "command";
  }
  if (reference.startsWith("research:")) {
    return "research";
  }
  if (reference.startsWith("resource:")) {
    return "resource";
  }
  if (reference.startsWith("output:")) {
    return "output";
  }
  return "artifact";
}

function freezeOutcome(
  plan: EvalPlan,
  attempts: readonly EvaluationAttemptOutcome[],
  finalOutput: string,
): EvaluationOutcome {
  const latest = attempts.at(-1);
  if (latest === undefined) {
    throw new Error("Evaluation completed without an attempt.");
  }
  return Object.freeze({
    attempts: Object.freeze([...attempts]),
    decision: latest.decision,
    finalOutput,
    plan,
    scorecard: latest.scorecard,
    storeRef: `eval:${plan.runId}:${latest.attemptId}`,
  });
}

function startEvaluationTrace(
  flow: AtomicFlowRun | undefined,
  attemptId: string,
  attemptIndex: number,
) {
  if (flow === undefined) {
    return undefined;
  }
  const trigger = flow.start({
    atom: EVAL_ATOMS.trigger,
    payload: {
      counts: {
        attempt: attemptIndex + 1,
      },
      values: {
        attemptId,
      },
    },
  });
  const attempt = flow.start({
    atom: EVAL_ATOMS.attempt,
    edge: {
      fromAtomKey: EVAL_ATOMS.trigger.key,
      fromInstanceId: trigger.instanceId,
      kind: "execution",
      toAtomKey: EVAL_ATOMS.attempt.key,
    },
    instanceId: `eval-attempt-${attemptId}`,
    parentInstanceId: trigger.instanceId,
  });
  return { attempt, flow, trigger };
}

function emitResults(
  trace: ReturnType<typeof startEvaluationTrace>,
  scorecard: EvaluationScorecard,
): void {
  if (trace === undefined) {
    return;
  }
  for (const result of scorecard.results) {
    const span = trace.flow.start({
      atom: evaluatorAtom(result.evaluator, result.label),
      edge: {
        fromAtomKey: EVAL_ATOMS.attempt.key,
        fromInstanceId: trace.attempt.instanceId,
        kind: "execution",
        toAtomKey: `eval.${result.evaluator}`,
      },
      parentInstanceId: trace.attempt.instanceId,
    });
    const payload = {
      ...(result.errorCode !== undefined ? { code: result.errorCode } : {}),
      durationMs: result.durationMs,
      summary: result.summary,
      values: {
        passed: result.passed,
        score: result.score ?? 0,
        status: result.status,
      },
    };
    if (result.status === "error") {
      span.fail(payload);
    } else if (result.status === "not-run") {
      span.skip(payload);
    } else {
      span.end(payload);
    }
  }
}

function finishEvaluationTrace(
  trace: ReturnType<typeof startEvaluationTrace>,
  scorecard: EvaluationScorecard,
  decision: CompletionDecision,
): void {
  if (trace === undefined) {
    return;
  }
  trace.attempt.end({
    counts: scorecard.counts,
    durationMs: scorecard.durationMs,
    values: {
      grade: scorecard.grade,
      overallScore: scorecard.overallScore,
      passed: scorecard.passed,
    },
  });
  const scorecardSpan = trace.flow.start({
    atom: EVAL_ATOMS.scorecard,
    edge: {
      fromAtomKey: EVAL_ATOMS.attempt.key,
      fromInstanceId: trace.attempt.instanceId,
      kind: "data",
      toAtomKey: EVAL_ATOMS.scorecard.key,
    },
    parentInstanceId: trace.attempt.instanceId,
  });
  scorecardSpan.end({
    counts: scorecard.counts,
    durationMs: scorecard.durationMs,
    values: {
      averageScore: scorecard.averageScore,
      correctness: scorecard.dimensionScores.correctness,
      grade: scorecard.grade,
      overallScore: scorecard.overallScore,
      passed: scorecard.passed,
      performance: scorecard.dimensionScores.performance,
      resourceEfficiency: scorecard.dimensionScores["resource-efficiency"],
      safetyReliability: scorecard.dimensionScores["safety-reliability"],
    },
  });
  const decisionSpan = trace.flow.start({
    atom: EVAL_ATOMS.decision,
    edge: {
      fromAtomKey: EVAL_ATOMS.scorecard.key,
      fromInstanceId: scorecardSpan.instanceId,
      kind: "execution",
      toAtomKey: EVAL_ATOMS.decision.key,
    },
    parentInstanceId: scorecardSpan.instanceId,
  });
  decisionSpan.end({
    summary: decision.action,
    values: {
      action: decision.action,
    },
  });
  const gate = trace.flow.start({
    atom: EVAL_ATOMS.gate,
    edge: {
      fromAtomKey: EVAL_ATOMS.decision.key,
      fromInstanceId: decisionSpan.instanceId,
      kind: "execution",
      toAtomKey: EVAL_ATOMS.gate.key,
    },
    parentInstanceId: decisionSpan.instanceId,
  });
  gate.end({
    summary: decision.action,
    values: {
      passed: decision.action === "accepted" || decision.action === "degraded",
    },
  });
  trace.trigger.end({
    counts: scorecard.counts,
    summary: decision.action,
  });
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "EVAL_RUNNER_FAILED";
}
