import {
  CallbackHookExecutor,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it } from "vitest";
import { PromptExpansion } from "../../src/session/prompt-expansion.js";

describe("PromptExpansion", () => {
  it("modifies expanded prompts and returns context", async () => {
    const expansion = new PromptExpansion({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({
        additionalContext: "command context",
        hookSpecificOutput: {
          hookEventName: "UserPromptExpansion",
          updatedValue: "expanded prompt",
        },
      })),
    });

    await expect(expansion.expand("review", "original", "--strict")).resolves.toMatchObject({
      additionalContext: ["command context"],
      prompt: "expanded prompt",
    });
  });

  it("blocks expansion and preserves behavior without Hooks", async () => {
    const blocked = new PromptExpansion({
      eventBase: eventBase(),
      hookSession: hookSession(() => ({ action: "block", reason: "disabled" })),
    });

    await expect(blocked.expand("review", "original")).rejects.toThrow("disabled");
    await expect(
      new PromptExpansion({ eventBase: eventBase() }).expand("review", "original"),
    ).resolves.toEqual({
      additionalContext: [],
      prompt: "original",
    });
  });
});

function hookSession(callback: () => object): HookSession {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: {
        hooks: {
          UserPromptExpansion: [{ hooks: [{ callback, name: "expansion", type: "callback" }] }],
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
    hook_event_name: "UserPromptExpansion",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
