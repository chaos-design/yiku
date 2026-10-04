export type AtomicFlowErrorCode =
  | "ATOMIC_FLOW_CLOSED"
  | "ATOMIC_FLOW_INVALID_ATOM"
  | "ATOMIC_FLOW_INVALID_EVENT"
  | "ATOMIC_FLOW_INVALID_INSTANCE"
  | "ATOMIC_FLOW_INVALID_RUN"
  | "ATOMIC_FLOW_JSONL_INVALID"
  | "ATOMIC_FLOW_SINK_FAILED";

export class AtomicFlowError extends Error {
  public constructor(
    public readonly code: AtomicFlowErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AtomicFlowError";
  }
}
