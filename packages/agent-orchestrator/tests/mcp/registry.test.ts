import { describe, expect, it, vi } from "vitest";
import { type McpConnection, McpRegistry } from "../../src/mcp/registry.js";

describe("McpRegistry", () => {
  it("connects, caches tools, invokes allowlisted tools, and closes connections", async () => {
    const connection = fakeConnection("policy");
    connection.listTools.mockResolvedValue([
      {
        description: "Evaluate policy",
        inputSchema: {
          properties: {
            mode: { type: "string" },
          },
          type: "object",
        },
        name: "evaluate",
      },
      {
        inputSchema: { properties: {}, type: "object" },
        name: "write",
      },
    ]);
    const registry = new McpRegistry({
      allowedTargets: ["policy/eval*"],
    });
    registry.register(connection);

    expect(registry.status()).toEqual([
      {
        name: "policy",
        status: "pending",
        toolCount: 0,
        tools: [],
      },
    ]);
    await registry.connectAll();
    await expect(registry.listTools(["policy"])).resolves.toEqual([
      {
        description: "Evaluate policy",
        inputSchema: {
          properties: {
            mode: { type: "string" },
          },
          type: "object",
        },
        name: "evaluate",
        server: "policy",
      },
    ]);
    await registry.listTools(["policy"]);
    expect(connection.listTools).toHaveBeenCalledTimes(3);
    expect(registry.status()).toEqual([
      {
        name: "policy",
        status: "connected",
        toolCount: 2,
        tools: ["evaluate", "write"],
      },
    ]);
    await expect(
      registry.invoke("policy", "evaluate", { mode: "strict" }, { timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: true });
    expect(connection.invoke).toHaveBeenCalledWith(
      "evaluate",
      { mode: "strict" },
      { timeoutMs: 1_000 },
    );
    await registry.close();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(registry.status()).toEqual([
      {
        name: "policy",
        status: "disconnected",
        toolCount: 0,
        tools: [],
      },
    ]);
  });

  it("reports connecting state and sorts status entries by name", async () => {
    let finishConnect: (() => void) | undefined;
    const beta = fakeConnection("beta");
    beta.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = resolve;
        }),
    );
    const registry = new McpRegistry();
    registry.register(beta);
    registry.register(fakeConnection("alpha"));

    const connecting = registry.connect("beta");
    expect(registry.status()).toEqual([
      {
        name: "alpha",
        status: "pending",
        toolCount: 0,
        tools: [],
      },
      {
        name: "beta",
        status: "connecting",
        toolCount: 0,
        tools: [],
      },
    ]);

    finishConnect?.();
    await connecting;
  });

  it("rejects duplicate, unknown, disconnected, and non-allowlisted targets", async () => {
    const unrestrictedRegistry = new McpRegistry();
    await expect(
      unrestrictedRegistry.invoke("missing", "evaluate", {}, { timeoutMs: 1 }),
    ).rejects.toThrow("not registered");
    await expect(unrestrictedRegistry.connect("missing")).rejects.toThrow("not registered");
    await expect(unrestrictedRegistry.reconnect("missing")).rejects.toThrow("not registered");
    await expect(unrestrictedRegistry.listTools(["missing"])).rejects.toThrow("not registered");

    const registry = new McpRegistry({ allowedTargets: ["policy/evaluate"] });
    const connection = fakeConnection("policy");
    registry.register(connection);

    expect(() => registry.register(connection)).toThrow("already exists");
    await expect(registry.invoke("policy", "evaluate", {}, { timeoutMs: 1 })).rejects.toThrow(
      "not connected",
    );
    await registry.connectAll();
    await expect(registry.invoke("policy", "write", {}, { timeoutMs: 1 })).rejects.toThrow(
      "not allowlisted",
    );
  });

  it("keeps healthy connections when connectAll reports aggregate failures", async () => {
    const healthy = fakeConnection("healthy");
    const failure = new Error("connect failed");
    const failed = fakeConnection("failed");
    failed.connect.mockRejectedValue(failure);
    const later = fakeConnection("later");
    const registry = new McpRegistry();
    registry.register(healthy);
    registry.register(failed);
    registry.register(later);

    const result = await registry.connectAll().catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([failure]);
    expect(healthy.close).not.toHaveBeenCalled();
    expect(later.connect).toHaveBeenCalledOnce();
    await expect(registry.invoke("healthy", "evaluate", {}, { timeoutMs: 1 })).resolves.toEqual({
      ok: true,
    });
    expect(registry.status()).toEqual([
      {
        error: failure,
        name: "failed",
        status: "failed",
        toolCount: 0,
        tools: [],
      },
      {
        name: "healthy",
        status: "connected",
        toolCount: 1,
        tools: ["evaluate"],
      },
      {
        name: "later",
        status: "connected",
        toolCount: 1,
        tools: ["evaluate"],
      },
    ]);
  });

  it("reconnects after closing and refreshes the tool cache", async () => {
    const connection = fakeConnection("policy");
    connection.listTools
      .mockResolvedValueOnce([
        {
          inputSchema: { properties: {}, type: "object" },
          name: "before",
        },
      ])
      .mockResolvedValue([
        {
          inputSchema: { properties: {}, type: "object" },
          name: "after",
        },
      ]);
    const registry = new McpRegistry();
    registry.register(connection);

    await registry.connect("policy");
    await registry.reconnect("policy");

    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.connect).toHaveBeenCalledTimes(2);
    await expect(registry.listTools()).resolves.toEqual([
      {
        inputSchema: { properties: {}, type: "object" },
        name: "after",
        server: "policy",
      },
    ]);
    expect(registry.status()).toEqual([
      {
        name: "policy",
        status: "connected",
        toolCount: 1,
        tools: ["after"],
      },
    ]);
  });

  it("marks reconnect as failed when closing the existing connection fails", async () => {
    const connection = fakeConnection("policy");
    const failure = new Error("close failed");
    const registry = new McpRegistry();
    registry.register(connection);
    await registry.connect("policy");
    connection.close.mockRejectedValueOnce(failure);

    await expect(registry.reconnect("policy")).rejects.toBe(failure);
    expect(connection.connect).toHaveBeenCalledOnce();
    expect(registry.status()).toEqual([
      {
        error: failure,
        name: "policy",
        status: "failed",
        toolCount: 0,
        tools: [],
      },
    ]);
  });

  it("settles all closes and marks every server disconnected", async () => {
    const first = fakeConnection("first");
    const second = fakeConnection("second");
    const registry = new McpRegistry();
    registry.register(first);
    registry.register(second);
    await registry.connectAll();
    first.close.mockImplementationOnce(() => {
      throw new Error("close failed");
    });

    await expect(registry.close()).resolves.toBeUndefined();
    expect(second.close).toHaveBeenCalledOnce();
    expect(registry.status().map(({ status }) => status)).toEqual(["disconnected", "disconnected"]);
  });

  it("rejects tool discovery for disconnected servers", async () => {
    const registry = new McpRegistry();
    registry.register(fakeConnection("policy"));
    await expect(registry.listTools(["policy"])).rejects.toThrow("not connected");
    await registry.close();
  });
});

function fakeConnection(name: string): McpConnection & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
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
          type: "object",
        },
        name: "evaluate",
      },
    ]),
    name,
  };
}
