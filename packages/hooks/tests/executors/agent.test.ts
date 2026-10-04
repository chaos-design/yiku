import { describe, expect, it, vi } from "vitest";
import { HookExecutionError } from "../../src/errors.js";
import { AgentHookExecutor } from "../../src/executors/agent.js";
import { HookLimits } from "../../src/security/limits.js";
import type { HookAgentRunner, HookInvocation } from "../../src/types.js";

describe("AgentHookExecutor", () => {
  it("passes independent turn, tool, token, output, and timeout budgets", async () => {
    const run = vi.fn<HookAgentRunner["run"]>(async () => ({ decision: "block" }));
    const invocation = agentInvocation();
    const executor = new AgentHookExecutor({
      limits: new HookLimits({
        maxAgentTokens: 1_000,
        maxAgentToolCalls: 7,
        maxOutputBytes: 2_000,
      }),
      runner: { run },
    });

    await expect(
      executor.execute(invocation, invocation.handler, context()),
    ).resolves.toMatchObject({
      output: { decision: "block" },
      status: "success",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputBytes: 2_000,
        maxTokens: 1_000,
        maxToolCalls: 7,
        maxTurns: 12,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects recursion, invalid output, and the wrong handler type", async () => {
    const invocation = agentInvocation();
    const executor = new AgentHookExecutor({
      runner: {
        async run() {
          return { decision: "block" };
        },
      },
    });

    await expect(
      executor.execute(invocation, invocation.handler, { ...context(), depth: 1 }),
    ).rejects.toThrow("recursion depth");
    await expect(
      executor.execute(invocation, { prompt: "wrong", type: "prompt" }, context()),
    ).rejects.toBeInstanceOf(HookExecutionError);

    const invalid = new AgentHookExecutor({
      runner: {
        async run() {
          return { additionalContext: "not valid for Stop" };
        },
      },
    });
    await expect(invalid.execute(invocation, invocation.handler, context())).rejects.toThrow(
      "does not support additional context",
    );
  });
});

function agentInvocation(): HookInvocation {
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
      maxTurns: 12,
      prompt: "Verify: $ARGUMENTS",
      type: "agent",
    },
    hookId: "hook-agent",
    invocationId: "invocation-agent",
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
