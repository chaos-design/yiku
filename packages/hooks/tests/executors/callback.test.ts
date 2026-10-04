import { describe, expect, it } from "vitest";
import { HookExecutionError, HookTimeoutError } from "../../src/errors.js";
import { CallbackHookExecutor } from "../../src/executors/callback.js";
import type { HookInvocation } from "../../src/types.js";

describe("CallbackHookExecutor", () => {
  it("executes and validates callback output", async () => {
    const executor = new CallbackHookExecutor();
    const invocation = callbackInvocation(() => ({
      additionalContext: "runtime context",
    }));

    await expect(
      executor.execute(invocation, invocation.handler, executionContext()),
    ).resolves.toMatchObject({
      output: {
        additionalContext: "runtime context",
      },
      status: "success",
    });
  });

  it("wraps callback failures and rejects invalid output", async () => {
    const executor = new CallbackHookExecutor();
    const failed = callbackInvocation(() => {
      throw new Error("raw callback failure");
    });
    const invalid = callbackInvocation(
      () =>
        ({
          unknown: true,
        }) as never,
    );

    await expect(
      executor.execute(failed, failed.handler, executionContext()),
    ).rejects.toBeInstanceOf(HookExecutionError);
    await expect(executor.execute(invalid, invalid.handler, executionContext())).rejects.toThrow(
      "Hook output is invalid",
    );
  });

  it("honors deadlines and abort signals", async () => {
    const executor = new CallbackHookExecutor();
    const waiting = callbackInvocation(() => new Promise(() => undefined));

    await expect(
      executor.execute(waiting, waiting.handler, {
        ...executionContext(),
        deadline: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(HookTimeoutError);

    const controller = new AbortController();
    const execution = executor.execute(waiting, waiting.handler, {
      ...executionContext(),
      signal: controller.signal,
    });
    controller.abort("canceled");
    await expect(execution).rejects.toMatchObject({ code: "HOOK_ABORTED" });
  });

  it("rejects the wrong handler type", async () => {
    const executor = new CallbackHookExecutor();
    const invocation = callbackInvocation(() => ({}));

    await expect(
      executor.execute(
        invocation,
        {
          command: "echo wrong",
          type: "command",
        },
        executionContext(),
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });
});

function callbackInvocation(
  callback: Extract<HookInvocation["handler"], { type: "callback" }>["callback"],
) {
  return {
    event: {
      cwd: "/workspace",
      hook_event_name: "SessionStart",
      permission_mode: "default",
      session_id: "session-1",
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
    },
    handler: {
      callback,
      name: "runtime",
      type: "callback",
    },
    hookId: "hook-1",
    invocationId: "invocation-1",
    source: {
      priority: 100,
      type: "runtime",
    },
  } satisfies HookInvocation;
}

function executionContext() {
  return {
    deadline: Date.now() + 1_000,
    depth: 0,
    environment: {},
  };
}
