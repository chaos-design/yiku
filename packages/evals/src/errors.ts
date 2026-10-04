export type EvalErrorCode =
  | "EVAL_ABORTED"
  | "EVAL_ARTIFACT_CHANGED"
  | "EVAL_COMMAND_FAILED"
  | "EVAL_COMMAND_SIGNALLED"
  | "EVAL_DEPENDENCY_FAILED"
  | "EVAL_EVALUATOR_FAILED"
  | "EVAL_EVIDENCE_MISSING"
  | "EVAL_INPUT_TOO_LARGE"
  | "EVAL_INVALID_RESULT"
  | "EVAL_NETWORK_UNAVAILABLE"
  | "EVAL_PLAN_UNSATISFIABLE"
  | "EVAL_PROFILE_INVALID"
  | "EVAL_PROVIDER_UNAVAILABLE"
  | "EVAL_REPAIR_EXHAUSTED"
  | "EVAL_REQUIRED_NOT_RUN"
  | "EVAL_RUNNER_FAILED"
  | "EVAL_SCHEMA_UNSUPPORTED"
  | "EVAL_STORE_CONFLICT"
  | "EVAL_STORE_CORRUPT"
  | "EVAL_STORE_UNAVAILABLE"
  | "EVAL_TIMEOUT"
  | "EVAL_UNKNOWN_RECEIPT";

export class EvaluationError extends Error {
  public constructor(
    public readonly code: EvalErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EvaluationError";
  }
}

export function unsupportedEvaluationVersion(record: string, version: unknown): EvaluationError {
  return new EvaluationError(
    "EVAL_SCHEMA_UNSUPPORTED",
    `Unsupported evaluation ${record} version: ${String(version)}.`,
  );
}
