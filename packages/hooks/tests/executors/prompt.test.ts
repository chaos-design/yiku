import { describe, expect, it, vi } from "vitest";
import { HookExecutionError } from "../../src/errors.js";
import { PromptHookExecutor } from "../../src/executors/prompt.js";
import type { HookInvocation, HookModelRunner } from "../../src/types.js";

describe("PromptHookExecutor", () => {
  it("passes rendered input, model, budget, deadline, and signal to the runner", async () => {
    const run = vi.fn<HookModelRunner["run"]>(async () => ({ decision: "block" }));
    const invocation = promptInvocation();
    const executor = new PromptHookExecutor({ runner: { run } });

    await expect(
      executor.execute(invocation, invocation.handler, context()),
    ).resolves.toMatchObject({
      output: { decision: "block" },
      status: "success",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputBytes: 1_048_576,
        model: "fast-model",
        prompt: expect.stringContaining('"hook_event_name":"Stop"'),
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("rejects invalid runner output and the wrong handler type", async () => {
    const invalid = new PromptHookExecutor({
      runner: {
        async run() {
          return { updatedInput: { command: "not valid for Stop" } };
        },
      },
    });
    const invocation = promptInvocation();

    await expect(invalid.execute(invocation, invocation.handler, context())).rejects.toThrow(
      "does not support output modification",
    );
    await expect(
      invalid.execute(invocation, { command: "echo wrong", type: "command" }, context()),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });
});

function promptInvocation(): HookInvocation {
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
      model: "fast-model",
      prompt: "Decide: $ARGUMENTS",
      type: "prompt",
    },
    hookId: "hook-prompt",
    invocationId: "invocation-prompt",
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
