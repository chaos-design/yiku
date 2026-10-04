import {
  CallbackHookExecutor,
  type HookCallback,
  HookConfigCompiler,
  HookEngine,
  type HookEventName,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { ToolBatchTracker } from "../../src/runtime/tool-batch.js";
import { HookToolBlockedError, ToolHookMiddleware } from "../../src/runtime/tool-hooks.js";

describe("ToolHookMiddleware", () => {
  it("modifies validated input before execution and records success", async () => {
    const observed: HookEventName[] = [];
    const execute = vi.fn(async (input: { command: string }) => `ran ${input.command}`);
    const validate = vi.fn((input: unknown) => input as { command: string });
    const batch = new ToolBatchTracker();
    const middleware = middlewareFor(
      {
        PostToolUse: eventRecorder(observed),
        PreToolUse: eventRecorder(observed, {
          updatedInput: { command: "pnpm test" },
        }),
      },
      batch,
    );

    await expect(
      middleware.run({
        callId: "call-1",
        execute,
        input: { command: "pnpm lint" },
        toolName: "Bash",
        validate,
      }),
    ).resolves.toBe("ran pnpm test");

    expect(validate).toHaveBeenCalledWith({ command: "pnpm test" });
    expect(execute).toHaveBeenCalledWith({ command: "pnpm test" });
    expect(observed).toEqual(["PreToolUse", "PostToolUse"]);
    expect(batch.hasPending()).toBe(true);
  });

  it("blocks or defers before executing side effects", async () => {
    for (const action of ["block", "defer"] as const) {
      const execute = vi.fn(async () => "not called");
      const middleware = middlewareFor({
        PreToolUse: () => ({ action, reason: action }),
      });

      await expect(
        middleware.run({
          execute,
          input: { command: "rm -rf build" },
          toolName: "Bash",
          validate: (input) => input as { command: string },
        }),
      ).rejects.toBeInstanceOf(HookToolBlockedError);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("dispatches failure Hooks and preserves the original error", async () => {
    const failure = vi.fn(() => ({ additionalContext: "failure context" }));
    const middleware = middlewareFor({
      PostToolUseFailure: failure,
    });
    const error = new Error("tool failed");

    await expect(
      middleware.run({
        callId: "call-1",
        execute: async () => Promise.reject(error),
        input: { path: "missing" },
        toolName: "Read",
        validate: (input) => input as { path: string },
      }),
    ).rejects.toBe(error);
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          error: "tool failed",
          tool_use_id: "call-1",
        }),
      }),
      expect.any(Object),
    );
  });

  it("normalizes non-object input and undefined output with a generated call ID", async () => {
    const post = vi.fn(() => ({}));
    const middleware = middlewareFor({
      PostToolUse: post,
    });

    await expect(
      middleware.run({
        execute: async () => undefined,
        input: ["value"],
        toolName: "Custom",
        validate: (input) => input as string[],
      }),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          tool_input: { value: ["value"] },
          tool_response: null,
          tool_use_id: expect.any(String),
        }),
      }),
      expect.any(Object),
    );
  });

  it("aggregates original and failure-Hook errors", async () => {
    const hookSession = hookSessionFor({});
    vi.spyOn(hookSession, "dispatch").mockImplementation(async (event) => {
      if (event.hook_event_name === "PostToolUseFailure") {
        throw new Error("failure hook failed");
      }
      return {
        action: "no-op",
        additionalContext: [],
        diagnostics: [],
        permissionUpdates: [],
        reasons: [],
        suppressOutput: false,
        systemMessages: [],
      };
    });
    const middleware = new ToolHookMiddleware(
      {
        cwd: "/workspace",
        hookSession,
        permissionMode: "default",
        sessionId: "session-1",
        transcriptPath: "/tmp/transcript.jsonl",
      },
      new ToolBatchTracker(),
    );

    await expect(
      middleware.run({
        execute: async () => Promise.reject("tool failed"),
        input: null,
        signal: AbortSignal.abort(),
        toolName: "Custom",
        validate: (input) => input,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});

function middlewareFor(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
  batch = new ToolBatchTracker(),
): ToolHookMiddleware {
  const hookSession = hookSessionFor(handlers);

  return new ToolHookMiddleware(
    {
      cwd: "/workspace",
      hookSession,
      permissionMode: "default",
      sessionId: "session-1",
      transcriptPath: "/tmp/transcript.jsonl",
    },
    batch,
  );
}

function hookSessionFor(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
): HookSession {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: { hooks },
    },
  ]).snapshot;
  const hookSession = new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });

  return hookSession;
}

function eventRecorder(
  events: HookEventName[],
  output: ReturnType<HookCallback> = {},
): HookCallback {
  return (invocation) => {
    events.push(invocation.event.hook_event_name);
    return output;
  };
}
