import { describe, expect, it, vi } from "vitest";
import { HookExecutionError, HookSecurityError } from "../../src/errors.js";
import { McpHookExecutor } from "../../src/executors/mcp.js";
import type { HookInvocation, HookMcpInvoker } from "../../src/types.js";

describe("McpHookExecutor", () => {
  it("invokes an allowlisted target with arguments and cancellation", async () => {
    const invoke = vi.fn<HookMcpInvoker["invoke"]>(async () => ({ decision: "block" }));
    const invocation = mcpInvocation();
    const executor = new McpHookExecutor({
      allowedTargets: ["policy/evaluate"],
      invoker: { invoke },
    });

    await expect(
      executor.execute(invocation, invocation.handler, context()),
    ).resolves.toMatchObject({
      output: { decision: "block" },
      status: "success",
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { mode: "strict" },
        server: "policy",
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
        tool: "evaluate",
      }),
    );
  });

  it("rejects targets outside the allowlist and recursive invocation", async () => {
    const invocation = mcpInvocation();
    const executor = new McpHookExecutor({
      allowedTargets: [],
      invoker: { invoke: async () => ({}) },
    });

    await expect(
      executor.execute(invocation, invocation.handler, context()),
    ).rejects.toBeInstanceOf(HookSecurityError);

    const allowed = new McpHookExecutor({
      allowedTargets: ["policy/evaluate"],
      invoker: { invoke: async () => ({}) },
    });
    await expect(
      allowed.execute(invocation, invocation.handler, { ...context(), depth: 1 }),
    ).rejects.toThrow("recursion depth");
  });

  it("rejects invalid output and the wrong handler type", async () => {
    const invocation = mcpInvocation();
    const invalid = new McpHookExecutor({
      allowedTargets: ["policy/evaluate"],
      invoker: {
        async invoke() {
          return { updatedInput: { invalid: true } };
        },
      },
    });

    await expect(invalid.execute(invocation, invocation.handler, context())).rejects.toThrow(
      "does not support output modification",
    );
    await expect(
      invalid.execute(invocation, { prompt: "wrong", type: "prompt" }, context()),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });
});

function mcpInvocation(): HookInvocation {
  return {
    event: {
      cwd: "/workspace",
      hook_event_name: "Stop",
      permission_mode: "default",
      session_id: "session-1",
      stop_hook_active: false,
      transcript_path: "/tmp/transcript.jsonl",
    },
    handler: {
      arguments: { mode: "strict" },
      server: "policy",
      tool: "evaluate",
      type: "mcp",
    },
    hookId: "hook-mcp",
    invocationId: "invocation-mcp",
    source: {
      priority: 500,
      type: "project",
    },
  };
}

function context() {
  return {
    deadline: Date.now() + 1_000,
    depth: 0,
    environment: {},
  };
}
