import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { Notifier } from "../../src/notifications/notifier.js";

describe("Notifier", () => {
  it("dispatches Notification before the sink", async () => {
    const order: string[] = [];
    const sink = vi.fn(() => {
      order.push("sink");
    });
    const notifier = new Notifier({
      eventBase: eventBase(),
      hookSession: hookSession(() => {
        order.push("hook");
        return {};
      }),
      sink,
    });

    await notifier.notify({
      message: "Approval required",
      type: "permission_prompt",
    });

    expect(order).toEqual(["hook", "sink"]);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("allows Hook policy to suppress the host notification", async () => {
    const sink = vi.fn();
    const notifier = new Notifier({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({ suppressOutput: true })),
      sink,
    });

    await notifier.notify({ message: "done", type: "agent_completed" });
    expect(sink).not.toHaveBeenCalled();
  });

  it("delivers titled notifications without a Hook Session", async () => {
    const sink = vi.fn();
    const notifier = new Notifier({
      eventBase: eventBase(),
      sink,
    });
    const notification = {
      message: "Authentication completed",
      title: "Signed in",
      type: "auth_success" as const,
    };

    await expect(notifier.notify(notification)).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledWith(notification);
  });

  it("forwards titles through the Hook event", async () => {
    const callback = vi.fn(() => ({}));
    const notifier = new Notifier({
      eventBase: eventBase(),
      hookSession: hookSession(callback),
      sink: vi.fn(),
    });

    await notifier.notify({
      message: "Review",
      title: "Approval",
      type: "permission_prompt",
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          title: "Approval",
        }),
      }),
      expect.any(Object),
    );
  });
});

function hookSession(callback: () => object): HookSession {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          Notification: [{ hooks: [{ callback, name: "notify", type: "callback" }] }],
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
    hook_event_name: "Notification",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
