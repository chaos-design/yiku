import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { ToolBatchTracker } from "../../src/runtime/tool-batch.js";

describe("ToolBatchTracker", () => {
  it("flushes completed tools in start order and clears the batch", async () => {
    const callback = vi.fn(() => ({ additionalContext: "batch context" }));
    const hookSession = hookSessionFor(callback);
    const tracker = new ToolBatchTracker();
    tracker.begin("call-1");
    tracker.begin("call-1");
    tracker.begin("call-2");
    tracker.finish("call-2", "Edit", "failed");
    tracker.finish("call-1", "Bash", "succeeded");

    const decision = await tracker.flush({
      eventBase: eventBase(),
      hookSession,
    });

    expect(decision).toMatchObject({ additionalContext: ["batch context"] });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          results: [
            {
              status: "succeeded",
              tool_name: "Bash",
              tool_use_id: "call-1",
            },
            {
              status: "failed",
              tool_name: "Edit",
              tool_use_id: "call-2",
            },
          ],
        }),
      }),
      expect.any(Object),
    );
    expect(tracker.hasPending()).toBe(false);
    await expect(tracker.flush({ eventBase: eventBase(), hookSession })).resolves.toBeUndefined();
  });
});

function hookSessionFor(callback: () => { additionalContext: string }): HookSession {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          PostToolBatch: [
            {
              hooks: [{ callback, name: "batch", type: "callback" }],
            },
          ],
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
    hook_event_name: "PostToolBatch",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
