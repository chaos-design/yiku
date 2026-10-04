import { type HookAgentRunInput, HookExecutionError } from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { OpenAIHookAgentRunner } from "../../src/hooks/agent-runner.js";
import type { AgentRunner } from "../../src/runtime/types.js";

describe("OpenAIHookAgentRunner", () => {
  it("runs a bounded agent with configured tools", async () => {
    const runner = vi.fn<AgentRunner>(async () => ({
      finalOutput: '{"decision":"block"}',
      usage: usage(100),
    }));
    const adapter = new OpenAIHookAgentRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner,
      tools: [{} as never],
    });

    await expect(adapter.run(agentInput())).resolves.toEqual({ decision: "block" });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 5,
        model: "model",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("enforces tool-call and token budgets", async () => {
    const toolBudget = new OpenAIHookAgentRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner: async (input) => {
        input.onEvent?.({
          summary: "called",
          title: "Tool",
          toolName: "Read",
          type: "tool_called",
        });
        input.onEvent?.({
          summary: "called",
          title: "Tool",
          toolName: "Read",
          type: "tool_called",
        });
        if (input.signal?.aborted) {
          throw input.signal.reason;
        }
        return { finalOutput: "{}" };
      },
    });
    await expect(toolBudget.run({ ...agentInput(), maxToolCalls: 1 })).rejects.toThrow(
      "tool-call budget",
    );

    const tokenBudget = new OpenAIHookAgentRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner: async () => ({
        finalOutput: "{}",
        usage: usage(101),
      }),
    });
    await expect(tokenBudget.run({ ...agentInput(), maxTokens: 100 })).rejects.toThrow(
      "token budget",
    );
  });

  it("forwards model, base URL, and parent cancellation", async () => {
    const parent = new AbortController();
    parent.abort(new HookExecutionError("HOOK_ABORTED", "parent canceled"));
    const runner = vi.fn<AgentRunner>(async (input) => {
      if (input.signal?.aborted) {
        throw input.signal.reason;
      }
      return { finalOutput: "{}" };
    });
    const adapter = new OpenAIHookAgentRunner({
      apiKey: "secret",
      baseURL: "https://api.example.test/v1",
      defaultModel: "default",
      runner,
    });

    await expect(
      adapter.run({
        ...agentInput(),
        model: "override",
        signal: parent.signal,
      }),
    ).rejects.toMatchObject({ code: "HOOK_ABORTED" });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.example.test/v1",
        model: "override",
      }),
    );
  });

  it("sanitizes generic Agent provider failures", async () => {
    const adapter = new OpenAIHookAgentRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner: async () => {
        throw new Error("provider secret");
      },
    });

    await expect(adapter.run(agentInput())).rejects.toMatchObject({
      code: "HOOK_EXECUTION_FAILED",
      message: "Hook Agent execution failed.",
    });
  });
});

function agentInput(): HookAgentRunInput {
  return {
    event: {
      cwd: "/workspace",
      hook_event_name: "Stop",
      permission_mode: "default",
      session_id: "session-1",
      stop_hook_active: false,
      transcript_path: "/tmp/transcript.jsonl",
    },
    maxOutputBytes: 1_024,
    maxTokens: 1_000,
    maxToolCalls: 10,
    maxTurns: 5,
    prompt: "evaluate",
    timeoutMs: 1_000,
  };
}

function usage(totalTokens: number) {
  return {
    cachedInputTokens: 0,
    inputTokens: Math.floor(totalTokens / 2),
    outputTokens: Math.ceil(totalTokens / 2),
    peakInputTokens: Math.floor(totalTokens / 2),
    totalTokens,
  };
}
