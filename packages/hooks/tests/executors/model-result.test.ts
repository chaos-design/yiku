import { describe, expect, it } from "vitest";
import { HookExecutionError, HookProtocolError, HookTimeoutError } from "../../src/errors.js";
import {
  renderHookPrompt,
  runHookOperation,
  validateRunnerOutput,
} from "../../src/executors/model-result.js";
import type { HookInvocation } from "../../src/types.js";

describe("model Hook result helpers", () => {
  it("replaces every arguments marker with event JSON", () => {
    const invocation = promptInvocation();
    const rendered = renderHookPrompt("Before $ARGUMENTS after $ARGUMENTS", invocation.event);

    expect(rendered.match(/"hook_event_name":"Stop"/gu)).toHaveLength(2);
    expect(rendered).not.toContain("$ARGUMENTS");
  });

  it("validates protocol output and output byte limits", () => {
    const invocation = promptInvocation();

    expect(validateRunnerOutput(invocation, { decision: "block" }, 1_024)).toEqual({
      decision: "block",
    });
    expect(() => validateRunnerOutput(invocation, { systemMessage: "x".repeat(100) }, 10)).toThrow(
      HookExecutionError,
    );
    expect(() =>
      validateRunnerOutput(
        invocation,
        {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
          },
        },
        1_024,
      ),
    ).toThrow(HookProtocolError);
  });

  it("enforces deadline, abort, and error translation", async () => {
    const invocation = promptInvocation();

    await expect(
      runHookOperation(
        invocation,
        { deadline: Date.now() - 1, depth: 0, environment: {} },
        async () => ({}),
      ),
    ).rejects.toBeInstanceOf(HookTimeoutError);

    const controller = new AbortController();
    const aborted = runHookOperation(
      invocation,
      {
        deadline: Date.now() + 1_000,
        depth: 0,
        environment: {},
        signal: controller.signal,
      },
      () => new Promise(() => undefined),
    );
    controller.abort("canceled");
    await expect(aborted).rejects.toMatchObject({ code: "HOOK_ABORTED" });

    await expect(
      runHookOperation(
        invocation,
        { deadline: Date.now() + 1_000, depth: 0, environment: {} },
        async () => {
          throw new Error("provider failure");
        },
      ),
    ).rejects.toMatchObject({ code: "HOOK_EXECUTION_FAILED" });
  });

  it("preserves typed cancellation and enforces active operation timeouts", async () => {
    const invocation = promptInvocation();
    const parent = new AbortController();
    parent.abort(new HookExecutionError("HOOK_ABORTED", "typed parent cancellation"));

    await expect(
      runHookOperation(
        invocation,
        {
          deadline: Date.now() + 1_000,
          depth: 0,
          environment: {},
          signal: parent.signal,
        },
        () => new Promise(() => undefined),
      ),
    ).rejects.toThrow("typed parent cancellation");
    await expect(
      runHookOperation(
        invocation,
        { deadline: Date.now() + 5, depth: 0, environment: {} },
        () => new Promise(() => undefined),
      ),
    ).rejects.toBeInstanceOf(HookTimeoutError);
    await expect(
      runHookOperation(
        invocation,
        { deadline: Date.now() + 1_000, depth: 0, environment: {} },
        async () => {
          throw new HookExecutionError("HOOK_ABORTED", "typed operation cancellation");
        },
      ),
    ).rejects.toThrow("typed operation cancellation");
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
