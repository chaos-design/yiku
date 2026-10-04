import { HookExecutionError, type HookModelRunInput, HookProtocolError } from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { OpenAIHookModelRunner, parseHookRunnerOutput } from "../../src/hooks/model-runner.js";
import type { AgentRunner } from "../../src/runtime/types.js";

describe("OpenAIHookModelRunner", () => {
  it("runs a one-turn tool-free evaluator and parses JSON output", async () => {
    const runner = vi.fn<AgentRunner>(async () => ({
      finalOutput: '{"decision":"block","reason":"policy"}',
    }));
    const adapter = new OpenAIHookModelRunner({
      apiKey: "secret",
      defaultModel: "default-model",
      runner,
    });

    await expect(adapter.run(modelInput())).resolves.toEqual({
      decision: "block",
      reason: "policy",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "secret",
        maxTurns: 1,
        model: "override-model",
        prompt: "evaluate",
      }),
    );
  });

  it("rejects malformed output and sanitizes provider failures", async () => {
    const invalid = new OpenAIHookModelRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner: async () => ({ finalOutput: "not-json" }),
    });
    await expect(invalid.run(modelInput())).rejects.toBeInstanceOf(HookProtocolError);

    const failed = new OpenAIHookModelRunner({
      apiKey: "secret",
      defaultModel: "model",
      runner: async () => {
        throw new Error("provider secret detail");
      },
    });
    await expect(failed.run(modelInput())).rejects.toMatchObject({
      code: "HOOK_EXECUTION_FAILED",
      message: "Hook model evaluation failed.",
    });
    await expect(failed.run(modelInput())).rejects.toBeInstanceOf(HookExecutionError);
  });

  it("supports default models, base URLs, signals, and object runner output", async () => {
    const signal = new AbortController().signal;
    const runner = vi.fn<AgentRunner>(async () => ({
      finalOutput: { decision: "allow" },
    }));
    const adapter = new OpenAIHookModelRunner({
      apiKey: "secret",
      baseURL: "https://api.example.test/v1",
      defaultModel: "default-model",
      runner,
    });
    const { model: _model, ...inputWithoutModel } = modelInput();

    await expect(adapter.run({ ...inputWithoutModel, signal })).resolves.toEqual({
      decision: "allow",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.example.test/v1",
        model: "default-model",
        signal,
      }),
    );
  });

  it("rejects oversized and non-serializable structured output", () => {
    expect(() =>
      parseHookRunnerOutput(
        { event: modelInput().event, maxOutputBytes: 2 },
        '{"decision":"allow"}',
      ),
    ).toThrow("byte limit");
    expect(() =>
      parseHookRunnerOutput({ event: modelInput().event, maxOutputBytes: 1_024 }, undefined),
    ).toThrow("bounded JSON");
    expect(() =>
      parseHookRunnerOutput(
        { event: modelInput().event, maxOutputBytes: 2 },
        { decision: "allow" },
      ),
    ).toThrow("bounded JSON");
  });
});

function modelInput(): HookModelRunInput {
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
    model: "override-model",
    prompt: "evaluate",
    timeoutMs: 1_000,
  };
}
