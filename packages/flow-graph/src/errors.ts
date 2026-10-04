export type FlowGraphErrorCode =
  | "FLOW_GRAPH_DUPLICATE_ID"
  | "FLOW_GRAPH_INVALID_BOUNDS"
  | "FLOW_GRAPH_INVALID_INPUT"
  | "FLOW_GRAPH_INVALID_PORT"
  | "FLOW_GRAPH_INVALID_ROUTE_BOUNDS"
  | "FLOW_GRAPH_INVALID_SEGMENT_OFFSET"
  | "FLOW_GRAPH_UNKNOWN_ENDPOINT";

export interface FlowGraphErrorOptions extends ErrorOptions {
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly path?: string | undefined;
}

export class FlowGraphError extends Error {
  public readonly code: FlowGraphErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;
  public readonly path: string | undefined;

  public constructor(
    code: FlowGraphErrorCode,
    message: string,
    options: FlowGraphErrorOptions = {},
  ) {
    super(message, options);
    this.name = "FlowGraphError";
    this.code = code;
    this.details = options.details;
    this.path = options.path;
  }
}
