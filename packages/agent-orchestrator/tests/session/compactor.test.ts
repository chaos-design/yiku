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
import { ContextCompactor } from "../../src/session/compactor.js";
import { SessionHistory } from "../../src/session/history.js";

describe("ContextCompactor", () => {
  it("atomically replaces history and applies pre/post Hook context", async () => {
    const history = historyWithMessages();
    const summarize = vi.fn(async () => "compact summary");
    const compactor = new ContextCompactor({
      eventBase: eventBase(),
      history,
      hookSession: hookSession({
        PostCompact: () => ({ additionalContext: "post context" }),
        PreCompact: () => ({}),
      }),
      maxSummaryChars: 100,
      summarizer: { summarize },
    });

    await expect(compactor.compact("manual", "custom")).resolves.toMatchObject({
      summary: "compact summary",
    });
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "custom",
        maxChars: 100,
      }),
    );
    expect(history.list()).toEqual([
      { content: "compact summary", role: "assistant" },
      { content: "post context", role: "user" },
    ]);
  });

  it("blocks before summarization and preserves history", async () => {
    const history = historyWithMessages();
    const before = history.list();
    const summarize = vi.fn(async () => "not called");
    const compactor = new ContextCompactor({
      eventBase: eventBase(),
      history,
      hookSession: hookSession({
        PreCompact: () => ({ action: "block", reason: "not now" }),
      }),
      summarizer: { summarize },
    });

    await expect(compactor.compact("auto")).rejects.toThrow("not now");
    expect(summarize).not.toHaveBeenCalled();
    expect(history.list()).toEqual(before);
  });

  it("preserves history when summarization fails or returns an invalid summary", async () => {
    for (const summarize of [
      async () => Promise.reject(new Error("failed")),
      async () => "",
      async () => "too long",
    ]) {
      const history = historyWithMessages();
      const before = history.list();
      const compactor = new ContextCompactor({
        eventBase: eventBase(),
        history,
        maxSummaryChars: 3,
        summarizer: { summarize },
      });

      await expect(compactor.compact("manual")).rejects.toBeInstanceOf(Error);
      expect(history.list()).toEqual(before);
    }
  });

  it("compacts successfully without Hooks and forwards AbortSignal", async () => {
    const history = historyWithMessages();
    const signal = new AbortController().signal;
    const summarize = vi.fn(async () => "standalone summary");
    const compactor = new ContextCompactor({
      eventBase: eventBase(),
      history,
      signal,
      summarizer: { summarize },
    });

    await expect(compactor.compact("auto", " standalone ")).resolves.toEqual({
      summary: "standalone summary",
    });
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "standalone",
        maxChars: 8_000,
        signal,
      }),
    );
    expect(history.list()).toEqual([
      {
        content: "standalone summary",
        role: "assistant",
      },
    ]);
  });
});

function historyWithMessages(): SessionHistory {
  const history = new SessionHistory();
  history.append("user", "question");
  history.append("assistant", "answer");
  return history;
}

function hookSession(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
): HookSession {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    { source: hookSource("runtime"), value: { hooks } },
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
    hook_event_name: "PreCompact",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
