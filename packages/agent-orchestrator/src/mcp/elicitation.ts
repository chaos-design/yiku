import type {
  ElicitationHookEvent,
  HookEventBase,
  HookSession,
  JsonObject,
  JsonValue,
} from "@yiku/hooks";

export interface McpElicitationRequest {
  readonly message: string;
  readonly mode?: ElicitationHookEvent["mode"] | undefined;
  readonly requestId: string;
  readonly requestedSchema?: JsonObject | undefined;
  readonly server: string;
  readonly url?: string | undefined;
}

export interface McpElicitationResponse {
  readonly action: "accept" | "cancel" | "decline";
  readonly result?: JsonValue | undefined;
}

export type McpElicitationHandler = (
  request: McpElicitationRequest,
) => Promise<McpElicitationResponse> | McpElicitationResponse;

export interface McpElicitationBridgeOptions {
  readonly eventBase: HookEventBase<"Elicitation">;
  readonly hookSession?: HookSession | undefined;
  readonly userHandler?: McpElicitationHandler | undefined;
}

export class McpElicitationBridge {
  public constructor(private readonly options: McpElicitationBridgeOptions) {}

  public async request(input: McpElicitationRequest): Promise<McpElicitationResponse> {
    const decision = await this.options.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "Elicitation",
      mcp_server_name: input.server,
      message: input.message,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      request_id: input.requestId,
      ...(input.requestedSchema !== undefined ? { requested_schema: input.requestedSchema } : {}),
    });

    let response: McpElicitationResponse;
    if (decision?.action === "block" || decision?.action === "stop") {
      response = { action: "decline" };
    } else if (decision?.updatedValue !== undefined) {
      response = {
        action: "accept",
        result: decision.updatedValue,
      };
    } else {
      response =
        this.options.userHandler === undefined
          ? { action: "decline" }
          : await this.options.userHandler(input);
    }

    const resultDecision = await this.options.hookSession?.dispatch({
      ...this.options.eventBase,
      action: response.action,
      hook_event_name: "ElicitationResult",
      mcp_server_name: input.server,
      request_id: input.requestId,
      ...(response.result !== undefined ? { result: response.result } : {}),
    });

    if (resultDecision?.action === "block" || resultDecision?.action === "stop") {
      return { action: "cancel" };
    }

    return resultDecision?.updatedValue === undefined
      ? response
      : {
          ...response,
          result: resultDecision.updatedValue,
        };
  }
}
