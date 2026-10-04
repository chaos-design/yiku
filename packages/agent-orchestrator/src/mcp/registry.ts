import type { JsonObject } from "@yiku/hooks";

export interface McpConnectionTool {
  readonly description?: string | undefined;
  readonly inputSchema: JsonObject;
  readonly name: string;
}

export interface McpToolDefinition extends McpConnectionTool {
  readonly server: string;
}

export type McpRegistryServerStatus =
  | "pending"
  | "connecting"
  | "connected"
  | "failed"
  | "disconnected";

export interface McpRegistryStatusEntry {
  readonly error?: Error | undefined;
  readonly name: string;
  readonly status: McpRegistryServerStatus;
  readonly toolCount: number;
  readonly tools: readonly string[];
}

export interface McpConnection {
  readonly name: string;
  close(): Promise<void>;
  connect(): Promise<void>;
  listTools(): Promise<readonly McpConnectionTool[]>;
  invoke(
    tool: string,
    arguments_: JsonObject,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<unknown>;
}

export interface McpRegistryOptions {
  readonly allowedTargets?: readonly string[] | undefined;
}

interface McpRegistryServerState {
  readonly error?: Error | undefined;
  readonly status: McpRegistryServerStatus;
  readonly tools: readonly McpConnectionTool[];
}

export class McpRegistry {
  private readonly allowedTargets?: readonly string[] | undefined;
  private readonly connections = new Map<string, McpConnection>();
  private readonly states = new Map<string, McpRegistryServerState>();

  public constructor(options: McpRegistryOptions = {}) {
    this.allowedTargets =
      options.allowedTargets === undefined ? undefined : Object.freeze([...options.allowedTargets]);
  }

  public register(connection: McpConnection): void {
    if (this.connections.has(connection.name)) {
      throw new Error(`MCP connection already exists: ${connection.name}.`);
    }
    this.connections.set(connection.name, connection);
    this.states.set(connection.name, {
      status: "pending",
      tools: Object.freeze([]),
    });
  }

  public async connect(server: string): Promise<void> {
    const connection = this.requireConnection(server);
    const state = this.requireState(server);
    if (state.status === "connected") {
      return;
    }

    this.states.set(server, {
      status: "connecting",
      tools: Object.freeze([]),
    });

    try {
      await connection.connect();
      const tools = Object.freeze([...(await connection.listTools())]);
      this.states.set(server, {
        status: "connected",
        tools,
      });
    } catch (error) {
      const failure = asError(error);
      this.states.set(server, {
        error: failure,
        status: "failed",
        tools: Object.freeze([]),
      });
      throw failure;
    }
  }

  public async connectAll(): Promise<void> {
    const errors: Error[] = [];

    for (const server of this.connections.keys()) {
      try {
        await this.connect(server);
      } catch (error) {
        errors.push(asError(error));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `One or more MCP servers failed to connect: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  }

  public async invoke(
    server: string,
    tool: string,
    arguments_: JsonObject,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<unknown> {
    const target = `${server}/${tool}`;
    if (!this.isTargetAllowed(target)) {
      throw new Error(`MCP target is not allowlisted: ${target}.`);
    }

    const connection = this.requireConnection(server);
    if (this.requireState(server).status !== "connected") {
      throw new Error(`MCP server is not connected: ${server}.`);
    }

    return connection.invoke(tool, arguments_, options);
  }

  public async listTools(
    servers: readonly string[] = this.list(),
  ): Promise<readonly McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];

    for (const server of servers) {
      const connection = this.requireConnection(server);
      const state = this.requireState(server);
      if (state.status !== "connected") {
        throw new Error(`MCP server is not connected: ${server}.`);
      }
      let discoveredTools: readonly McpConnectionTool[];
      try {
        discoveredTools = Object.freeze([...(await connection.listTools())]);
        this.states.set(server, {
          status: "connected",
          tools: discoveredTools,
        });
      } catch (error) {
        const failure = asError(error);
        this.states.set(server, {
          error: failure,
          status: "failed",
          tools: Object.freeze([]),
        });
        throw failure;
      }
      for (const tool of discoveredTools) {
        if (this.isTargetAllowed(`${server}/${tool.name}`)) {
          tools.push(Object.freeze({ ...tool, server }));
        }
      }
    }

    return Object.freeze(tools);
  }

  public async reconnect(server: string): Promise<void> {
    const connection = this.requireConnection(server);

    try {
      await connection.close();
    } catch (error) {
      const failure = asError(error);
      this.states.set(server, {
        error: failure,
        status: "failed",
        tools: Object.freeze([]),
      });
      throw failure;
    }

    this.states.set(server, {
      status: "disconnected",
      tools: Object.freeze([]),
    });
    await this.connect(server);
  }

  public status(): readonly McpRegistryStatusEntry[] {
    const entries = [...this.states.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, state]) =>
        Object.freeze({
          ...(state.error === undefined ? {} : { error: state.error }),
          name,
          status: state.status,
          toolCount: state.tools.length,
          tools: Object.freeze(state.tools.map((tool) => tool.name).sort()),
        }),
      );
    return Object.freeze(entries);
  }

  public async close(): Promise<void> {
    const connections = [...this.connections.values()].reverse();
    await Promise.allSettled(connections.map(async (connection) => connection.close()));
    for (const server of this.states.keys()) {
      this.states.set(server, {
        status: "disconnected",
        tools: Object.freeze([]),
      });
    }
  }

  public list(): readonly string[] {
    return Object.freeze([...this.connections.keys()].sort());
  }

  private requireConnection(server: string): McpConnection {
    const connection = this.connections.get(server);
    if (connection === undefined) {
      throw new Error(`MCP server is not registered: ${server}.`);
    }
    return connection;
  }

  private requireState(server: string): McpRegistryServerState {
    const state = this.states.get(server);
    if (state === undefined) {
      throw new Error(`MCP server is not registered: ${server}.`);
    }
    return state;
  }

  private isTargetAllowed(target: string): boolean {
    return (
      this.allowedTargets === undefined ||
      this.allowedTargets.some((pattern) => mcpTargetMatches(pattern, target))
    );
  }
}

export function mcpTargetMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
