import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it } from "vitest";
import { MessageDisplay } from "../../src/session/message-display.js";

describe("MessageDisplay", () => {
  it("modifies or suppresses messages before presentation", async () => {
    const modified = new MessageDisplay({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({
        hookSpecificOutput: {
          hookEventName: "MessageDisplay",
          updatedValue: "sanitized",
        },
      })),
    });
    await expect(modified.present("raw")).resolves.toMatchObject({
      message: "sanitized",
    });

    const suppressed = new MessageDisplay({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({ suppressOutput: true })),
    });
    await expect(suppressed.present("raw")).resolves.not.toHaveProperty("message");
  });

  it("returns the original message without Hooks", async () => {
    await expect(new MessageDisplay({ eventBase: eventBase() }).present("raw")).resolves.toEqual({
      message: "raw",
    });
  });
});

function hookSession(callback: () => object): HookSession {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          MessageDisplay: [{ hooks: [{ callback, name: "display", type: "callback" }] }],
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
    hook_event_name: "MessageDisplay",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
