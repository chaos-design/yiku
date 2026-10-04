import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { SetupRuntime } from "../../src/session/setup.js";

describe("SetupRuntime", () => {
  it("dispatches before executing setup", async () => {
    const order: string[] = [];
    const runtime = new SetupRuntime({
      eventBase: eventBase(),
      hookSession: hookSession(() => {
        order.push("hook");
        return { additionalContext: "setup context" };
      }),
    });

    await expect(
      runtime.run("init", async () => {
        order.push("operation");
        return "done";
      }),
    ).resolves.toMatchObject({
      decision: { additionalContext: ["setup context"] },
      result: "done",
    });
    expect(order).toEqual(["hook", "operation"]);
  });

  it("blocks setup before side effects", async () => {
    const operation = vi.fn(async () => "not called");
    const runtime = new SetupRuntime({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({ action: "block", reason: "blocked" })),
    });

    await expect(runtime.run("maintenance", operation)).rejects.toThrow("blocked");
    expect(operation).not.toHaveBeenCalled();
  });

  it("runs without Hooks", async () => {
    await expect(
      new SetupRuntime({ eventBase: eventBase() }).run("init", async () => "done"),
    ).resolves.toEqual({ result: "done" });
  });

  it("uses fallback text when setup is stopped without a reason", async () => {
    const session = hookSession(() => ({}));
    vi.spyOn(session, "dispatch").mockResolvedValue({
      action: "stop",
      additionalContext: [],
      diagnostics: [],
      permissionUpdates: [],
      reasons: [],
      suppressOutput: false,
      systemMessages: [],
    });
    const operation = vi.fn(async () => "unused");

    await expect(
      new SetupRuntime({
        eventBase: eventBase(),
        hookSession: session,
      }).run("init", operation),
    ).rejects.toThrow("blocked");
    expect(operation).not.toHaveBeenCalled();
  });
});

function hookSession(callback: () => object): HookSession {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          Setup: [{ hooks: [{ callback, name: "setup", type: "callback" }] }],
        },
      },
    },
  ]).snapshot;
  return new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });
}

function eventBase() {
  return {
    cwd: "/workspace",
    hook_event_name: "Setup",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
