import type { AtomicDefinition, AtomicFlowRun } from "@yiku/atomic-flow";
import { EVAL_ATOMS, evaluatorAtom } from "./atoms.js";
import { EvaluationError } from "./errors.js";
import { DEFAULT_EVALUATORS } from "./evaluators.js";
import type {
  EvalInput,
  EvalResult,
  EvalRunnerOptions,
  EvalScorecard,
  Evaluator,
  RunEvalsInput,
} from "./types.js";

export class EvalRunner {
  private readonly evaluators: readonly Evaluator[];
  private readonly judge;
  private readonly passThreshold: number;

  public constructor(options: EvalRunnerOptions = {}) {
    this.evaluators = options.evaluators ?? DEFAULT_EVALUATORS;
    this.judge = options.judge;
    this.passThreshold = options.passThreshold ?? 0.8;

    if (!Number.isFinite(this.passThreshold) || this.passThreshold < 0 || this.passThreshold > 1) {
      throw new EvaluationError(
        "EVAL_INVALID_RESULT",
        "Evaluation pass threshold must be between 0 and 1.",
      );
    }
  }

  public async run(input: RunEvalsInput): Promise<EvalScorecard> {
    throwIfAborted(input.signal);
    const trigger = startAtom(input.atomicFlow, EVAL_ATOMS.trigger, input.parentInstanceId, {
      fromAtomKey: "reply.final",
      kind: "feedback",
    });
    const results: EvalResult[] = [];

    for (const evaluator of this.evaluators) {
      results.push(await runEvaluator(evaluator, input, input.atomicFlow, trigger?.instanceId));
    }

    if (this.judge !== undefined) {
      const judge: Evaluator = {
        key: "judge",
        label: "LLM Judge",
        evaluate: (evalInput) => this.judge?.evaluate(evalInput) as Promise<EvalResult>,
      };
      results.push(await runEvaluator(judge, input, input.atomicFlow, trigger?.instanceId));
    }

    throwIfAborted(input.signal);
    const averageScore =
      results.length === 0
        ? 1
        : results.reduce((total, result) => total + result.score, 0) / results.length;
    const passed = results.every((result) => result.passed) && averageScore >= this.passThreshold;
    const scorecard: EvalScorecard = {
      averageScore,
      passed,
      results,
    };
    trigger?.end({
      counts: {
        evaluators: results.length,
        passed: results.filter((result) => result.passed).length,
      },
    });
    emitScorecard(input.atomicFlow, scorecard, trigger?.instanceId);
    return scorecard;
  }
}

async function runEvaluator(
  evaluator: Evaluator,
  input: EvalInput,
  flow?: AtomicFlowRun,
  parentInstanceId?: string,
): Promise<EvalResult> {
  throwIfAborted(input.signal);
  const span = startAtom(flow, evaluatorAtom(evaluator.key, evaluator.label), parentInstanceId, {
    fromAtomKey: EVAL_ATOMS.trigger.key,
    kind: "execution",
  });

  try {
    const result = await evaluator.evaluate(input);
    validateResult(result);
    span?.end({
      summary: result.summary,
      values: {
        passed: result.passed,
        score: result.score,
      },
    });
    return result;
  } catch (error) {
    if (error instanceof EvaluationError && error.code === "EVAL_ABORTED") {
      span?.fail({ code: error.code, summary: error.message });
      throw error;
    }

    const result: EvalResult = {
      error: error instanceof Error ? error.message : String(error),
      key: evaluator.key,
      label: evaluator.label,
      passed: false,
      score: 0,
      summary: "Evaluator failed.",
    };
    span?.fail({
      code: "EVAL_RUNNER_FAILED",
      summary: result.error,
    });
    return result;
  }
}

function emitScorecard(
  flow: AtomicFlowRun | undefined,
  scorecard: EvalScorecard,
  parentInstanceId?: string,
): void {
  if (flow === undefined) {
    return;
  }

  const scorecardSpan = flow.start({
    atom: EVAL_ATOMS.scorecard,
    edge: {
      fromAtomKey: EVAL_ATOMS.trigger.key,
      kind: "data",
      toAtomKey: EVAL_ATOMS.scorecard.key,
    },
    ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
  });
  scorecardSpan.end({
    values: {
      averageScore: scorecard.averageScore,
      passed: scorecard.passed,
    },
  });
  const gate = flow.start({
    atom: EVAL_ATOMS.gate,
    edge: {
      fromAtomKey: EVAL_ATOMS.scorecard.key,
      kind: "execution",
      toAtomKey: EVAL_ATOMS.gate.key,
    },
    parentInstanceId: scorecardSpan.instanceId,
  });
  gate.end({
    summary: scorecard.passed ? "accepted" : "rejected",
  });
}

function startAtom(
  flow: AtomicFlowRun | undefined,
  atom: AtomicDefinition,
  parentInstanceId?: string,
  edge?: {
    readonly fromAtomKey: string;
    readonly kind: "execution" | "feedback";
  },
) {
  return flow?.start({
    atom,
    ...(edge !== undefined
      ? {
          edge: {
            ...edge,
            toAtomKey: atom.key,
          },
        }
      : {}),
    ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
  });
}

function validateResult(result: EvalResult): void {
  if (
    !result.key.trim() ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 1
  ) {
    throw new EvaluationError("EVAL_INVALID_RESULT", "Evaluator returned an invalid result.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EvaluationError("EVAL_ABORTED", "Evaluation was aborted.");
  }
}
