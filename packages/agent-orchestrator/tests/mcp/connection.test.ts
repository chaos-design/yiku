import { describe, expect, it, vi } from "vitest";
import { type McpSdkClient, McpSdkConnection } from "../../src/mcp/connection.js";

describe("McpSdkConnection", () => {
  it("adapts SDK client lifecycle, tools, and invocation options", async () => {
    const transport = { name: "transport" };
    const client: McpSdkClient = {
      callTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" }] })),
      close: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            description: "Evaluate",
            inputSchema: { type: "object" },
            name: "evaluate",
          },
        ],
      })),
    };
    const connection = new McpSdkConnection({
      client,
      name: "policy",
      transport,
    });
    const signal = new AbortController().signal;

    await connection.connect();
    await expect(connection.listTools()).resolves.toEqual([
      {
        description: "Evaluate",
        inputSchema: { type: "object" },
        name: "evaluate",
      },
    ]);
    await expect(
      connection.invoke("evaluate", { mode: "strict" }, { signal, timeoutMs: 1_000 }),
    ).resolves.toEqual({ content: [{ text: "ok", type: "text" }] });
    expect(client.callTool).toHaveBeenCalledWith(
      {
        arguments: { mode: "strict" },
        name: "evaluate",
      },
      undefined,
      {
        signal,
        timeout: 1_000,
      },
    );
    expect(client.connect).toHaveBeenCalledWith(transport);
    await connection.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("omits absent descriptions and optional signals", async () => {
    const client: McpSdkClient = {
      callTool: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            inputSchema: { type: "object" },
            name: "plain",
          },
        ],
      })),
    };
    const connection = new McpSdkConnection({
      client,
      name: "plain",
      transport: {},
    });

    await expect(connection.listTools()).resolves.toEqual([
      {
        inputSchema: { type: "object" },
        name: "plain",
      },
    ]);
    await connection.invoke("plain", {}, { timeoutMs: 10 });
    expect(client.callTool).toHaveBeenCalledWith({ arguments: {}, name: "plain" }, undefined, {
      timeout: 10,
    });
  });
});
