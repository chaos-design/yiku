import type { JsonObject } from "@yiku/hooks";
import type { McpConnection, McpConnectionTool } from "./registry.js";

export interface McpSdkClient<TTransport = unknown> {
  callTool(
    input: {
      readonly arguments: JsonObject;
      readonly name: string;
    },
    resultSchema: undefined,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeout: number;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  connect(transport: TTransport): Promise<void>;
  listTools(): Promise<{
    readonly tools: readonly {
      readonly description?: string | undefined;
      readonly inputSchema: JsonObject;
      readonly name: string;
    }[];
  }>;
  setRequestHandler?(
    schema: unknown,
    handler: (request: McpSdkElicitationRequest) => Promise<McpSdkElicitationResult>,
  ): void;
}

export interface McpSdkElicitationRequest {
  readonly params:
    | {
        readonly message: string;
        readonly mode?: "form" | undefined;
        readonly requestedSchema: JsonObject;
      }
    | {
        readonly elicitationId: string;
        readonly message: string;
        readonly mode: "url";
        readonly url: string;
      };
}

export interface McpSdkElicitationResult {
  readonly action: "accept" | "cancel" | "decline";
  readonly content?: JsonObject | undefined;
}

export interface McpSdkConnectionOptions<TTransport = unknown> {
  readonly client: McpSdkClient<TTransport>;
  readonly name: string;
  readonly transport: TTransport;
}

export class McpSdkConnection<TTransport = unknown> implements McpConnection {
  public readonly name: string;

  public constructor(private readonly options: McpSdkConnectionOptions<TTransport>) {
    this.name = options.name;
  }

  public async connect(): Promise<void> {
    await this.options.client.connect(this.options.transport);
  }

  public async listTools(): Promise<readonly McpConnectionTool[]> {
    const result = await this.options.client.listTools();

    return Object.freeze(
      result.tools.map((tool) =>
        Object.freeze({
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          name: tool.name,
        }),
      ),
    );
  }

  public invoke(
    tool: string,
    arguments_: JsonObject,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<unknown> {
    return this.options.client.callTool(
      {
        arguments: arguments_,
        name: tool,
      },
      undefined,
      {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        timeout: options.timeoutMs,
      },
    );
  }

  public async close(): Promise<void> {
    await this.options.client.close();
  }
}
