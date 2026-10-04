import {
  type CompletionDecision,
  createCompletionDecision,
  type EvalCheckResult,
  type EvaluationScorecard,
  type OperationReceipt,
} from "@yiku/evals";

export interface CompletionPolicyInput {
  readonly canRepair: boolean;
  readonly maxRepairAttempts: 0 | 1;
  readonly operationReceipts: readonly OperationReceipt[];
  readonly repairAttemptsUsed: number;
  readonly scorecard: EvaluationScorecard;
}

export class CompletionPolicy {
  public decide(input: CompletionPolicyInput): CompletionDecision {
    const uncertain = input.operationReceipts.filter(
      (receipt) => receipt.result === "partial" || receipt.result === "unknown",
    );
    if (uncertain.length > 0) {
      return decision(input, "needs-review", [
        `Operation receipts require review: ${uncertain.map((receipt) => receipt.operationId).join(", ")}.`,
      ]);
    }

    const blockers = input.scorecard.results.filter(
      (result) => result.severity === "blocker" && result.status === "failed",
    );
    if (blockers.length > 0) {
      return this.failOrRetry(input, blockers, "A blocker evaluation check failed.");
    }

    const unavailableRequired = input.scorecard.results.filter(
      (result) => result.required && (result.status === "error" || result.status === "not-run"),
    );
    if (unavailableRequired.length > 0) {
      return decision(input, "needs-review", [
        `Required checks could not complete: ${checkIds(unavailableRequired)}.`,
      ]);
    }

    const failedRequired = input.scorecard.results.filter(
      (result) => result.required && result.status === "failed",
    );
    if (failedRequired.length > 0) {
      return this.failOrRetry(input, failedRequired, "A required evaluation check failed.");
    }

    if (!input.scorecard.qualityPassed) {
      const retryable = input.scorecard.results.filter(
        (result) => result.status !== "passed" && result.retryable,
      );
      return this.failOrRetry(
        input,
        retryable,
        `Evaluation score ${input.scorecard.overallScore.toFixed(3)} is below the required threshold.`,
      );
    }

    const optionalFailures = input.scorecard.results.filter(
      (result) => !result.required && result.status !== "passed",
    );
    if (optionalFailures.length > 0) {
      return decision(input, "degraded", [
        `Optional checks did not pass: ${checkIds(optionalFailures)}.`,
      ]);
    }

    return decision(input, "accepted", ["All required evaluation checks passed."]);
  }

  private failOrRetry(
    input: CompletionPolicyInput,
    failures: readonly EvalCheckResult[],
    reason: string,
  ): CompletionDecision {
    const retryable = failures.filter((result) => result.retryable);
    if (
      input.canRepair &&
      input.repairAttemptsUsed < input.maxRepairAttempts &&
      retryable.length > 0
    ) {
      return decision(input, "retry", [reason], {
        failedCheckIds: retryable.map((result) => result.id),
        feedback: retryable
          .map((result) => `${result.id}: ${result.feedback ?? result.summary}`)
          .join("\n")
          .slice(0, 8_000),
      });
    }
    return decision(input, "rejected", [
      reason,
      ...(retryable.length > 0 && input.repairAttemptsUsed >= input.maxRepairAttempts
        ? ["Automatic repair budget is exhausted."]
        : []),
    ]);
  }
}

function decision(
  input: CompletionPolicyInput,
  action: CompletionDecision["action"],
  reasons: readonly string[],
  repairInstruction?: NonNullable<CompletionDecision["repairInstruction"]>,
): CompletionDecision {
  return createCompletionDecision({
    action,
    attemptId: input.scorecard.attemptId,
    reasons,
    ...(repairInstruction !== undefined ? { repairInstruction } : {}),
    runId: input.scorecard.runId,
    taskId: input.scorecard.taskId,
  });
}

function checkIds(results: readonly EvalCheckResult[]): string {
  return results.map((result) => result.id).join(", ");
}
