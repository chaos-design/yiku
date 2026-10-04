import type { ToolExecutionMiddleware } from "@yiku/agent-code";
import { describe, expect, it, vi } from "vitest";
import { type McpConnection, McpRegistry } from "../../src/mcp/registry.js";
import { mcpTools } from "../../src/tools/mcp-tool.js";

describe("mcpTools", () => {
  it("discovers allowlisted tools and invokes through permission and middleware", async () => {
    const registry = new McpRegistry({
      allowedTargets: ["policy/evaluate"],
    });
    const connection = fakeConnection();
    registry.register(connection);
    await registry.connectAll();
    const permissionApprovalHandler = vi.fn(async () => ({
      decision: "allow" as const,
    }));
    const middleware: ToolExecutionMiddleware = {
      run: vi.fn(async (request) => {
        expect(request.effect).toBe("external");
        return request.execute(request.input);
      }),
    };
    const tools = await mcpTools({
      middleware,
      permissionApprovalHandler,
      registry,
      servers: ["policy"],
      workspaceId: "workspace-1",
    });

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__policy__evaluate"]);
    const result = await tools[0]?.invoke({} as never, JSON.stringify({ mode: "strict" }));
    expect(result).toContain('<prompt-context kind="reference" source="tool" trust="untrusted"');
    expect(result).toContain("{&quot;ok&quot;:true}");
    expect(tools[0]?.description).not.toContain("Evaluate policy");
    expect(permissionApprovalHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invoke MCP tool",
        capabilities: ["external.mcp.invoke"],
        normalizedAction: "invoke external MCP tool",
        policyId: "mcp-external-side-effect",
        risk: "high",
        subject: "policy/evaluate",
        workspaceId: "workspace-1",
      }),
    );
    expect(connection.invoke).toHaveBeenCalledWith(
      "evaluate",
      { mode: "strict" },
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    await registry.close();
  });

  it("fails closed when MCP permission is denied", async () => {
    const registry = new McpRegistry();
    registry.register(fakeConnection());
    await registry.connectAll();
    const tools = await mcpTools({
      permissionApprovalHandler: async () => ({
        decision: "deny",
        reason: "not approved",
      }),
      registry,
      servers: ["policy"],
    });

    await expect(
      tools[0]?.invoke({} as never, JSON.stringify({ mode: "strict" })),
    ).resolves.toContain("Error: Permission denied for policy/evaluate");
    await registry.close();
  });

  it("exposes only tools selected by the Skill target patterns", async () => {
    const registry = new McpRegistry();
    const connection = fakeConnection();
    connection.listTools.mockResolvedValue([
      {
        inputSchema: { properties: {}, type: "object" },
        name: "evaluate",
      },
      {
        inputSchema: { properties: {}, type: "object" },
        name: "write_policy",
      },
    ]);
    registry.register(connection);
    await registry.connectAll();

    const tools = await mcpTools({
      registry,
      targets: ["policy/eval*"],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__policy__evaluate"]);
    await registry.close();
  });

  it("validates timeout, Schema, and generated tool names before invocation", async () => {
    const registry = new McpRegistry();
    const connection = fakeConnection();
    registry.register(connection);
    await registry.connectAll();

    await expect(mcpTools({ registry, timeoutMs: 0 })).rejects.toThrow("positive integer");
    const tools = await mcpTools({ registry });
    await expect(tools[0]?.invoke({} as never, "{}")).resolves.toContain("Invalid MCP tool input");
    expect(connection.invoke).not.toHaveBeenCalled();

    connection.listTools.mockResolvedValue([
      { inputSchema: { properties: {}, type: "object" }, name: "a-b" },
      { inputSchema: { properties: {}, type: "object" }, name: "a_b" },
    ]);
    await expect(mcpTools({ registry })).rejects.toThrow("Duplicate MCP tool name");

    connection.listTools.mockResolvedValue([
      { inputSchema: { properties: {}, type: "object" }, name: "" },
    ]);
    await expect(mcpTools({ registry })).rejects.toThrow("supported character");
    await registry.close();
  });

  it("forwards call metadata and preserves string or undefined results", async () => {
    const registry = new McpRegistry();
    const connection = fakeConnection();
    registry.register(connection);
    await registry.connectAll();
    const middleware: ToolExecutionMiddleware = {
      run: (request) => request.execute(request.input),
    };
    const tools = await mcpTools({
      middleware,
      permissionApprovalHandler: async () => ({ decision: "allow" }),
      registry,
    });
    const signal = new AbortController().signal;
    connection.invoke.mockResolvedValueOnce("plain");

    await expect(
      tools[0]?.invoke({} as never, JSON.stringify({ mode: "strict" }), {
        signal,
        toolCall: { callId: "call-1" } as never,
      }),
    ).resolves.toContain("<content>\nplain\n</content>");
    expect(connection.invoke).toHaveBeenLastCalledWith(
      "evaluate",
      { mode: "strict" },
      { signal, timeoutMs: 30_000 },
    );

    connection.invoke.mockResolvedValueOnce(undefined);
    await expect(
      tools[0]?.invoke({} as never, JSON.stringify({ mode: "strict" })),
    ).resolves.toContain("<content>\nundefined\n</content>");
    await registry.close();
  });

  it("bounds untrusted MCP output before returning it to the model", async () => {
    const registry = new McpRegistry();
    const connection = fakeConnection();
    connection.invoke.mockResolvedValue("x".repeat(100));
    registry.register(connection);
    await registry.connectAll();
    const tools = await mcpTools({
      outputMaxCharacters: 24,
      permissionApprovalHandler: async () => ({ decision: "allow" }),
      registry,
    });

    const result = await tools[0]?.invoke({} as never, JSON.stringify({ mode: "strict" }));
    expect(result).toContain("[truncated]");
    expect(result).not.toContain("x".repeat(25));
    await registry.close();
  });

  it("rejects non-object inputs even when the remote Schema accepts them", async () => {
    const registry = new McpRegistry();
    const connection = fakeConnection();
    connection.listTools.mockResolvedValue([
      {
        inputSchema: {},
        name: "anything",
      },
    ]);
    registry.register(connection);
    await registry.connectAll();
    const tools = await mcpTools({ registry });

    await expect(tools[0]?.invoke({} as never, "[]")).resolves.toContain(
      "MCP tool input must be an object",
    );
    await registry.close();
  });
});

function fakeConnection(): McpConnection & {
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly listTools: ReturnType<typeof vi.fn>;
} {
  return {
    close: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    invoke: vi.fn(async () => ({ ok: true })),
    listTools: vi.fn(async () => [
      {
        description: "Evaluate policy",
        inputSchema: {
          properties: {
            mode: { type: "string" },
          },
          required: ["mode"],
          type: "object",
        },
        name: "evaluate",
      },
    ]),
    name: "policy",
  };
}
