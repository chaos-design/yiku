import { describe, expect, it, vi } from "vitest";
import type {
  ResolvedHttpMcpServerConfig,
  ResolvedStdioMcpServerConfig,
} from "../../src/config/types.js";
import {
  type McpSdkClient,
  McpServerFactory,
  mcpServerTrustDescriptor,
} from "../../src/mcp/server-factory.js";

describe("McpServerFactory", () => {
  it("creates stdio transports with an explicit environment allowlist", () => {
    const client = fakeClient();
    const stdioTransportFactory = vi.fn(() => ({ type: "stdio" }));
    const factory = new McpServerFactory({
      clientFactory: () => client,
      environment: {
        ALLOWED: "value",
        SECRET: "hidden",
      },
      stdioTransportFactory,
    });
    const config: ResolvedStdioMcpServerConfig = {
      args: ["server.js"],
      command: "node",
      cwd: "/workspace",
      env: ["ALLOWED"],
      name: "local",
      tools: ["*"],
      transport: "stdio",
    };

    factory.create(config);
    expect(stdioTransportFactory).toHaveBeenCalledWith({
      args: ["server.js"],
      command: "node",
      cwd: "/workspace",
      env: { ALLOWED: "value" },
      stderr: "pipe",
    });
  });

  it("creates HTTPS transports with substituted allowed headers", () => {
    const httpTransportFactory = vi.fn(() => ({ type: "http" }));
    const factory = new McpServerFactory({
      clientFactory: fakeClient,
      environment: {
        TOKEN: "secret-token",
      },
      httpTransportFactory,
    });
    const config: ResolvedHttpMcpServerConfig = {
      allowedEnvVars: ["TOKEN"],
      headers: {
        Authorization: `Bearer \${TOKEN}`,
      },
      name: "remote",
      tools: ["search_*"],
      transport: "streamable-http",
      url: "https://mcp.example.test/",
    };

    factory.create(config);
    expect(httpTransportFactory).toHaveBeenCalledWith(new URL(config.url), {
      requestInit: {
        headers: {
          Authorization: "Bearer secret-token",
        },
      },
    });
  });

  it("bridges SDK Elicitation requests to the configured handler", async () => {
    const client = fakeClient();
    const elicitationHandler = vi.fn(async () => ({
      action: "accept" as const,
      result: { mode: "strict" },
    }));
    const factory = new McpServerFactory({
      clientFactory: () => client,
      elicitationHandler,
      requestIdGenerator: () => "request-1",
      stdioTransportFactory: () => ({}),
    });
    const config: ResolvedStdioMcpServerConfig = {
      args: [],
      command: "server",
      env: [],
      name: "policy",
      tools: ["*"],
      transport: "stdio",
    };

    factory.create(config);
    const sdkHandler = vi.mocked(client.setRequestHandler).mock.calls[0]?.[1];
    await expect(
      sdkHandler?.({
        params: {
          message: "Choose",
          requestedSchema: { properties: {}, type: "object" },
        },
      }),
    ).resolves.toEqual({
      action: "accept",
      content: { mode: "strict" },
    });
    expect(elicitationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        server: "policy",
      }),
    );
  });

  it("includes process details in the trust descriptor", () => {
    const descriptor = mcpServerTrustDescriptor(
      {
        args: ["server.js"],
        command: "node",
        cwd: "/workspace",
        env: ["TOKEN"],
        name: "local",
        tools: ["*"],
        transport: "stdio",
      },
      "/workspace",
      "/workspace/.yiku/config.yaml",
    );

    expect(descriptor).toMatchObject({
      capability: "mcp:stdio:node",
      executorType: "mcp",
      source: {
        path: "/workspace/.yiku/config.yaml",
      },
    });
    expect(descriptor.handlerHash).toHaveLength(64);
  });

  it("uses default SDK clients and transports without connecting eagerly", async () => {
    const factory = new McpServerFactory();
    const stdio = factory.create({
      args: [],
      command: "node",
      env: [],
      name: "local",
      tools: ["*"],
      transport: "stdio",
    });
    const http = factory.create({
      allowedEnvVars: [],
      headers: {},
      name: "remote",
      tools: ["*"],
      transport: "streamable-http",
      url: "https://mcp.example.test/",
    });

    expect(stdio.name).toBe("local");
    expect(http.name).toBe("remote");
    await stdio.close();
    await http.close();
  });

  it("fails closed when Elicitation is unsupported or has no handler", async () => {
    const unsupported = fakeClient();
    delete unsupported.setRequestHandler;
    expect(() =>
      new McpServerFactory({
        clientFactory: () => unsupported,
        elicitationHandler: async () => ({ action: "accept" }),
        stdioTransportFactory: () => ({}),
      }).create({
        args: [],
        command: "server",
        env: [],
        name: "policy",
        tools: ["*"],
        transport: "stdio",
      }),
    ).toThrow("does not support Elicitation");

    const client = fakeClient();
    new McpServerFactory({
      clientFactory: () => client,
      stdioTransportFactory: () => ({}),
    }).create({
      args: [],
      command: "server",
      env: [],
      name: "policy",
      tools: ["*"],
      transport: "stdio",
    });
    const handler = vi.mocked(client.setRequestHandler).mock.calls[0]?.[1];
    await expect(
      handler?.({
        params: {
          message: "Choose",
          requestedSchema: { properties: {}, type: "object" },
        },
      }),
    ).resolves.toEqual({ action: "decline" });

    const unsupportedWithoutHandler = fakeClient();
    delete unsupportedWithoutHandler.setRequestHandler;
    expect(() =>
      new McpServerFactory({
        clientFactory: () => unsupportedWithoutHandler,
        stdioTransportFactory: () => ({}),
      }).create({
        args: [],
        command: "server",
        env: [],
        name: "plain",
        tools: ["*"],
        transport: "stdio",
      }),
    ).not.toThrow();
  });

  it("adapts URL Elicitation without form content", async () => {
    const client = fakeClient();
    const elicitationHandler = vi.fn(async () => ({
      action: "accept" as const,
      result: ["ignored"],
    }));
    new McpServerFactory({
      clientFactory: () => client,
      elicitationHandler,
      stdioTransportFactory: () => ({}),
    }).create({
      args: [],
      command: "server",
      env: [],
      name: "policy",
      tools: ["*"],
      transport: "stdio",
    });
    const handler = vi.mocked(client.setRequestHandler).mock.calls[0]?.[1];

    await expect(
      handler?.({
        params: {
          elicitationId: "elicit-1",
          message: "Open authorization",
          mode: "url",
          url: "https://example.test/authorize",
        },
      }),
    ).resolves.toEqual({ action: "accept" });
    expect(elicitationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "url",
        requestId: "elicit-1",
        url: "https://example.test/authorize",
      }),
    );
  });

  it("rejects unsafe or unavailable HTTP header substitutions", () => {
    const create = (headers: Readonly<Record<string, string>>, environment = {}) =>
      new McpServerFactory({
        clientFactory: fakeClient,
        environment,
        httpTransportFactory: () => ({}),
      }).create({
        allowedEnvVars: ["TOKEN"],
        headers,
        name: "remote",
        tools: ["*"],
        transport: "streamable-http",
        url: "https://mcp.example.test/",
      });

    expect(() => create({ "X-Test": "line\nbreak" })).toThrow("line break");
    expect(() => create({ Authorization: `Bearer \${SECRET}` }, { SECRET: "hidden" })).toThrow(
      "not allowlisted",
    );
    expect(() => create({ Authorization: `Bearer \${TOKEN}` })).toThrow("is not set");

    const stdioTransportFactory = vi.fn(() => ({}));
    new McpServerFactory({
      clientFactory: fakeClient,
      environment: {},
      stdioTransportFactory,
    }).create({
      args: [],
      command: "server",
      env: ["MISSING"],
      name: "local",
      tools: ["*"],
      transport: "stdio",
    });
    expect(stdioTransportFactory).toHaveBeenCalledWith(expect.objectContaining({ env: {} }));
  });

  it("builds sanitized HTTP trust descriptors and default stdio cwd summaries", () => {
    const http = mcpServerTrustDescriptor(
      {
        allowedEnvVars: ["TOKEN"],
        headers: { Authorization: `Bearer \${TOKEN}` },
        name: "remote",
        tools: ["*"],
        transport: "streamable-http",
        url: "https://user:secret@mcp.example.test/path?token=secret#fragment",
      },
      "/workspace",
      "/workspace/.yiku/config.yaml",
    );
    const stdio = mcpServerTrustDescriptor(
      {
        args: [],
        command: "server",
        env: [],
        name: "local",
        tools: ["*"],
        transport: "stdio",
      },
      "/workspace",
      "/workspace/.yiku/config.yaml",
    );

    expect(http.capability).toBe("mcp:https:https://mcp.example.test");
    expect(http.handlerHash).toHaveLength(64);
    expect(stdio.handlerHash).toHaveLength(64);
    expect(http.handlerHash).not.toBe(stdio.handlerHash);
  });
});

function fakeClient(): McpSdkClient {
  return {
    callTool: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    listTools: vi.fn(),
    setRequestHandler: vi.fn(),
  };
}
