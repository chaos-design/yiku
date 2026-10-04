import { HookExecutionError, type HookMcpInvokeInput } from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { type HookMcpRegistry, RegistryHookMcpInvoker } from "../../src/hooks/mcp-invoker.js";

describe("RegistryHookMcpInvoker", () => {
  it("invokes a registered tool and parses its result", async () => {
    const invoke = vi.fn<HookMcpRegistry["invoke"]>(async () => '{"decision":"block"}');
    const adapter = new RegistryHookMcpInvoker({
      registry: { invoke },
    });

    await expect(adapter.invoke(mcpInput())).resolves.toEqual({ decision: "block" });
    expect(invoke).toHaveBeenCalledWith(
      "policy",
      "evaluate",
      { mode: "strict" },
      expect.objectContaining({
        timeoutMs: 1_000,
      }),
    );
  });

  it("converts registry failures without exposing raw provider messages", async () => {
    const adapter = new RegistryHookMcpInvoker({
      registry: {
        async invoke() {
          throw new Error("server secret detail");
        },
      },
    });

    await expect(adapter.invoke(mcpInput())).rejects.toMatchObject({
      code: "HOOK_EXECUTION_FAILED",
      message: "Hook MCP invocation failed.",
    });
  });

  it("forwards AbortSignal and preserves stable Hook errors", async () => {
    const signal = new AbortController().signal;
    const invoke = vi.fn<HookMcpRegistry["invoke"]>(async () => {
      throw new HookExecutionError("HOOK_ABORTED", "typed cancellation");
    });
    const adapter = new RegistryHookMcpInvoker({
      registry: { invoke },
    });

    await expect(adapter.invoke({ ...mcpInput(), signal })).rejects.toMatchObject({
      code: "HOOK_ABORTED",
      message: "typed cancellation",
    });
    expect(invoke).toHaveBeenCalledWith(
      "policy",
      "evaluate",
      { mode: "strict" },
      { signal, timeoutMs: 1_000 },
    );
  });
});

function mcpInput(): HookMcpInvokeInput {
  return {
    arguments: { mode: "strict" },
    event: {
      cwd: "/workspace",
      hook_event_name: "Stop",
      permission_mode: "default",
      session_id: "session-1",
      stop_hook_active: false,
      transcript_path: "/tmp/transcript.jsonl",
    },
    server: "policy",
    timeoutMs: 1_000,
    tool: "evaluate",
  };
}
