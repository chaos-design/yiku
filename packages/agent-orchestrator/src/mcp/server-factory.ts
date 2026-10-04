import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, type HookTrustDescriptor, sha256 } from "@yiku/hooks";
import type {
  ResolvedHttpMcpServerConfig,
  ResolvedMcpServerConfig,
  ResolvedStdioMcpServerConfig,
} from "../config/types.js";
import {
  type McpSdkClient,
  McpSdkConnection,
  type McpSdkElicitationRequest,
  type McpSdkElicitationResult,
} from "./connection.js";
import type { McpElicitationHandler } from "./elicitation.js";
import type { McpConnection } from "./registry.js";

export type { McpSdkClient } from "./connection.js";

interface StdioTransportOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stderr: "pipe";
}

interface HttpTransportOptions {
  readonly requestInit: {
    readonly headers: Readonly<Record<string, string>>;
  };
}

export interface McpServerFactoryOptions {
  readonly clientFactory?: (() => McpSdkClient) | undefined;
  readonly elicitationHandler?: McpElicitationHandler | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  readonly httpTransportFactory?:
    | ((url: URL, options: HttpTransportOptions) => unknown)
    | undefined;
  readonly requestIdGenerator?: (() => string) | undefined;
  readonly stdioTransportFactory?: ((options: StdioTransportOptions) => unknown) | undefined;
}

export interface McpConnectionFactory {
  create(config: ResolvedMcpServerConfig): McpConnection;
}

export class McpServerFactory implements McpConnectionFactory {
  private readonly clientFactory: () => McpSdkClient;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly httpTransportFactory: (url: URL, options: HttpTransportOptions) => unknown;
  private readonly requestIdGenerator: () => string;
  private readonly stdioTransportFactory: (options: StdioTransportOptions) => unknown;

  public constructor(private readonly options: McpServerFactoryOptions = {}) {
    this.clientFactory = options.clientFactory ?? createClient;
    this.environment = options.environment ?? process.env;
    this.httpTransportFactory =
      options.httpTransportFactory ??
      ((url, transportOptions) => new StreamableHTTPClientTransport(url, transportOptions));
    this.requestIdGenerator = options.requestIdGenerator ?? randomUUID;
    this.stdioTransportFactory =
      options.stdioTransportFactory ??
      ((transportOptions) => new StdioClientTransport(transportOptions));
  }

  public create(config: ResolvedMcpServerConfig): McpSdkConnection {
    const client = this.clientFactory();
    this.registerElicitationHandler(client, config.name);
    const transport =
      config.transport === "stdio"
        ? this.createStdioTransport(config)
        : this.createHttpTransport(config);

    return new McpSdkConnection({
      client,
      name: config.name,
      transport,
    });
  }

  private createStdioTransport(config: ResolvedStdioMcpServerConfig): unknown {
    return this.stdioTransportFactory({
      args: [...config.args],
      command: config.command,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env: selectEnvironment(config.env, this.environment),
      stderr: "pipe",
    });
  }

  private createHttpTransport(config: ResolvedHttpMcpServerConfig): unknown {
    return this.httpTransportFactory(new URL(config.url), {
      requestInit: {
        headers: resolveHeaders(config, this.environment),
      },
    });
  }

  private registerElicitationHandler(client: McpSdkClient, server: string): void {
    if (client.setRequestHandler === undefined) {
      if (this.options.elicitationHandler !== undefined) {
        throw new Error(`MCP client does not support Elicitation: ${server}.`);
      }
      return;
    }

    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      this.handleElicitation(server, request),
    );
  }

  private async handleElicitation(
    server: string,
    request: McpSdkElicitationRequest,
  ): Promise<McpSdkElicitationResult> {
    const handler = this.options.elicitationHandler;
    if (handler === undefined) {
      return { action: "decline" };
    }

    const params = request.params;
    const response = await handler({
      message: params.message,
      mode: params.mode ?? "form",
      requestId: params.mode === "url" ? params.elicitationId : this.requestIdGenerator(),
      ...(params.mode === "form" || params.mode === undefined
        ? { requestedSchema: params.requestedSchema }
        : {}),
      server,
      ...(params.mode === "url" ? { url: params.url } : {}),
    });
    const result = toJsonObject(response.result);

    return {
      action: response.action,
      ...(result !== undefined ? { content: result } : {}),
    };
  }
}

export function mcpServerTrustDescriptor(
  config: ResolvedMcpServerConfig,
  workspaceDir: string,
  configPath: string,
): HookTrustDescriptor {
  const capability =
    config.transport === "stdio"
      ? `mcp:stdio:${config.command}`
      : `mcp:https:${new URL(config.url).origin}`;
  const trustedConfig =
    config.transport === "stdio"
      ? {
          args: config.args,
          command: config.command,
          cwd: config.cwd ?? workspaceDir,
          env: config.env,
          name: config.name,
          transport: config.transport,
        }
      : {
          allowedEnvVars: config.allowedEnvVars,
          headers: config.headers,
          name: config.name,
          transport: config.transport,
          url: withoutUrlSecrets(config.url),
        };

  return {
    capability,
    executorType: "mcp",
    handlerHash: sha256(canonicalJson(trustedConfig)),
    hookId: `mcp:${config.name}`,
    opaque: false,
    projectPath: workspaceDir,
    source: {
      componentId: config.name,
      path: configPath,
      priority: 30,
      type: "project",
    },
  };
}

function createClient(): McpSdkClient {
  return new Client(
    {
      name: "yiku-cli",
      version: "0.1.0",
    },
    {
      capabilities: {
        elicitation: {
          form: {},
          url: {},
        },
      },
    },
  ) as unknown as McpSdkClient;
}

function selectEnvironment(
  allowedNames: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const name of allowedNames) {
    const value = environment[name];
    if (value !== undefined) {
      selected[name] = value;
    }
  }

  return selected;
}

function resolveHeaders(
  config: ResolvedHttpMcpServerConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const allowedNames = new Set(config.allowedEnvVars);
  const headers: Record<string, string> = {};

  for (const [name, template] of Object.entries(config.headers)) {
    if (/[\r\n]/u.test(name) || /[\r\n]/u.test(template)) {
      throw new Error(`MCP header contains a line break: ${name}.`);
    }
    headers[name] = template.replaceAll(
      /\$\{([A-Z_][A-Z0-9_]*)\}/gu,
      (_match, variable: string) => {
        if (!allowedNames.has(variable)) {
          throw new Error(`MCP header environment variable is not allowlisted: ${variable}.`);
        }
        const value = environment[variable];
        if (value === undefined) {
          throw new Error(`MCP header environment variable is not set: ${variable}.`);
        }
        return value;
      },
    );
  }

  return Object.freeze(headers);
}

function toJsonObject(value: unknown): Record<string, never> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, never>)
    : undefined;
}

function withoutUrlSecrets(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
