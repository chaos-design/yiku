import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/session/agent-session.js";
import { AgentStageStopError } from "../../src/session/execution-policy.js";
import { InMemoryTaskStore } from "../../src/tasks/task-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("AgentSession", () => {
  it("reuses one Hook Session across turns and injects session/history context", async () => {
    const directory = await temporaryDirectory();
    const events: HookEventName[] = [];
    let stopCount = 0;
    const turnRunner = vi
      .fn()
      .mockResolvedValueOnce("draft")
      .mockResolvedValueOnce("done")
      .mockResolvedValueOnce("second turn");
    const session = new AgentSession({
      cwd: "/workspace",
      hooks: {
        engine: hookEngine({
          SessionEnd: callback(events, () => ({})),
          SessionStart: callback(events, () => ({ additionalContext: "session context" })),
          Stop: callback(events, () => {
            stopCount += 1;
            return stopCount === 1 ? { action: "block", reason: "run tests" } : {};
          }),
          UserPromptSubmit: callback(events, () => ({ additionalContext: "prompt context" })),
        }),
      },
      sessionId: "session-1",
      sessionsDir: directory,
      turnRunner,
    });

    await expect(session.submit("first turn")).resolves.toBe("done");
    await expect(session.submit("second turn")).resolves.toBe("second turn");
    await session.close("prompt_input_exit");

    expect(events.filter((event) => event === "SessionStart")).toHaveLength(1);
    expect(events.filter((event) => event === "UserPromptSubmit")).toHaveLength(2);
    expect(events.filter((event) => event === "Stop")).toHaveLength(3);
    expect(events.filter((event) => event === "SessionEnd")).toHaveLength(1);
    expect(turnRunner.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "session-1",
    });
    expect(turnRunner.mock.calls[0]?.[1].promptSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "session context",
          source: "hook",
          trust: "untrusted",
        }),
      ]),
    );
    expect(turnRunner.mock.calls[1]?.[0]).toBe("run tests");
    expect(turnRunner.mock.calls[1]?.[1].promptSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("<conversation_history>"),
          kind: "history",
        }),
      ]),
    );
    expect(turnRunner.mock.calls[2]?.[1].promptSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("first turn"),
          kind: "history",
        }),
      ]),
    );

    const transcript = await readFile(session.transcriptFilePath(), "utf8");
    expect(transcript).toContain('"kind":"message"');
    expect(transcript).toContain('"kind":"hook"');
  });

  it("blocks a prompt before invoking the turn runner", async () => {
    const directory = await temporaryDirectory();
    const turnRunner = vi.fn();
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          UserPromptSubmit: () => ({ action: "block", reason: "not allowed" }),
        }),
      },
      sessionId: "session-1",
      sessionsDir: directory,
      turnRunner,
    });

    await expect(session.submit("blocked")).rejects.toThrow("not allowed");
    expect(turnRunner).not.toHaveBeenCalled();
    await session.close();
  });

  it("dispatches StopFailure without replacing the original error", async () => {
    const directory = await temporaryDirectory();
    const stopFailure = vi.fn(() => ({}));
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          StopFailure: stopFailure,
        }),
      },
      sessionId: "session-1",
      sessionsDir: directory,
      turnRunner: async () => {
        throw new Error("model failed");
      },
    });

    await expect(session.submit("fail")).rejects.toThrow("model failed");
    expect(stopFailure).toHaveBeenCalledOnce();
    await session.close();
  });

  it("supports clear, compact, idempotent start, and idempotent close", async () => {
    const directory = await temporaryDirectory();
    const sources: string[] = [];
    const summarize = vi.fn(async () => "summary");
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          SessionStart: (invocation) => {
            if (invocation.event.hook_event_name === "SessionStart") {
              sources.push(invocation.event.source);
            }
            return {};
          },
        }),
        summarizer: {
          summarize,
        },
      },
      sessionId: "session-1",
      sessionsDir: directory,
      turnRunner: async () => "done",
    });

    await session.start("resume");
    await session.start("startup");
    await session.clear();
    await session.compact("manual", undefined, "focus on decisions");
    await session.close();
    await session.close();

    expect(sources).toEqual(["resume", "clear", "compact"]);
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ customInstructions: "focus on decisions" }),
    );
    await expect(session.submit("late")).rejects.toThrow("closed");
  });

  it("supports the no-Hook path, dynamic submit options, presentation, and validation", async () => {
    const directory = await temporaryDirectory();
    const onContext = vi.fn();
    const onEvent = vi.fn();
    const approval = vi.fn();
    const userQuestionHandler = vi.fn();
    const signal = new AbortController().signal;
    const turnRunner = vi.fn(async (_prompt, options) => {
      expect(options).toMatchObject({
        activatedSkills: ["review"],
        onContext,
        onEvent,
        permissionApprovalHandler: approval,
        signal,
        userQuestionHandler,
      });
      return "plain";
    });
    const session = new AgentSession({
      cwd: directory,
      sessionId: "no-hooks",
      sessionsDir: directory,
      turnRunner,
    });

    expect(session.sessionId()).toBe("no-hooks");
    await expect(session.present("visible")).resolves.toEqual({ message: "visible" });
    await expect(
      session.submit("prompt", {
        activatedSkills: ["review"],
        commandArgs: "focus tests",
        commandName: "review",
        onContext,
        onEvent,
        permissionApprovalHandler: approval,
        signal,
        userQuestionHandler,
      }),
    ).resolves.toBe("plain");
    await session.clear();
    await expect(session.compact("auto")).rejects.toThrow("requires a configured summarizer");
    await expect(session.submit(" ")).rejects.toThrow("must be non-empty");
    await session.close();
  });

  it("restores a prior history snapshot", async () => {
    const directory = await temporaryDirectory();
    const session = new AgentSession({
      initialHistory: [{ content: "newer turn", role: "user" }],
      sessionsDir: directory,
      turnRunner: async () => "unused",
    });

    session.restoreHistory([
      { content: "older turn", role: "user" },
      { content: "older answer", role: "assistant" },
    ]);

    expect(session.historySnapshot()).toEqual([
      { content: "older turn", role: "user" },
      { content: "older answer", role: "assistant" },
    ]);
    await session.close();
  });

  it("loads instructions without recording obsolete Worktree capability warnings", async () => {
    const directory = await temporaryDirectory();
    const instructionPath = join(directory, "CLAUDE.md");
    await writeFile(instructionPath, "Follow repository instructions.");
    const loaded = vi.fn(() => ({ additionalContext: "loaded context" }));
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("runtime"),
        value: {
          hooks: {
            InstructionsLoaded: [
              {
                hooks: [{ callback: loaded, name: "instructions", type: "callback" }],
              },
            ],
            WorktreeCreate: [
              {
                hooks: [{ callback: () => ({}), name: "worktree", type: "callback" }],
              },
            ],
          },
        },
      },
    ]).snapshot;
    const turnRunner = vi.fn(async () => "done");
    const session = new AgentSession({
      cwd: directory,
      hooks: {
        engine: new HookEngine({
          executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
          snapshot,
        }),
        instructionFiles: [instructionPath],
      },
      sessionId: "instructions",
      sessionsDir: directory,
      turnRunner,
    });

    await session.submit("inspect instructions");
    await session.close();

    expect(loaded).toHaveBeenCalledOnce();
    expect(turnRunner.mock.calls[0]?.[1].promptSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Follow repository instructions.",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          source: "workspace",
          sourceId: instructionPath,
          trust: "untrusted",
        }),
        expect.objectContaining({
          content: "loaded context",
          source: "hook",
          trust: "untrusted",
        }),
      ]),
    );
    const transcript = await readFile(session.transcriptFilePath(), "utf8");
    expect(transcript).not.toContain("WorktreeCreate and WorktreeRemove");
  });

  it("can close before start and rejects later lifecycle calls", async () => {
    const directory = await temporaryDirectory();
    const session = new AgentSession({
      sessionsDir: directory,
      turnRunner: async () => "unused",
    });

    await session.close();
    await expect(session.start()).rejects.toThrow("closed");
  });

  it("expands prompts after submission policy and injects expansion context", async () => {
    const directory = await temporaryDirectory();
    const order: string[] = [];
    const turnRunner = vi.fn(async () => "done");
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          UserPromptExpansion: () => {
            order.push("expand");
            return {
              additionalContext: "expanded context",
              hookSpecificOutput: {
                hookEventName: "UserPromptExpansion",
                updatedValue: "expanded prompt",
              },
            };
          },
          UserPromptSubmit: () => {
            order.push("submit");
            return {};
          },
        }),
      },
      sessionId: "expansion",
      sessionsDir: directory,
      turnRunner,
    });

    await expect(session.submit("original prompt")).resolves.toBe("done");
    expect(order).toEqual(["submit", "expand"]);
    expect(turnRunner).toHaveBeenCalledWith(
      "expanded prompt",
      expect.objectContaining({
        promptSegments: expect.arrayContaining([
          expect.objectContaining({
            content: "expanded context",
            source: "hook",
            trust: "untrusted",
          }),
        ]),
      }),
    );
    await session.close();
  });

  it("rejects unsafe direct or expanded prompts before invoking the turn runner", async () => {
    const directory = await temporaryDirectory();
    const turnRunner = vi.fn(async () => "unused");
    const direct = new AgentSession({
      sessionsDir: directory,
      turnRunner,
    });
    await expect(direct.submit("unsafe\u0000prompt")).rejects.toMatchObject({
      code: "PROMPT_CONTROL_CHARACTER",
    });
    await direct.close();

    const expanded = new AgentSession({
      hooks: {
        engine: hookEngine({
          UserPromptExpansion: () => ({
            hookSpecificOutput: {
              hookEventName: "UserPromptExpansion",
              updatedValue: "unsafe\u0000expanded",
            },
          }),
        }),
      },
      sessionsDir: directory,
      turnRunner,
    });
    await expect(expanded.submit("safe")).rejects.toMatchObject({
      code: "PROMPT_CONTROL_CHARACTER",
    });
    expect(turnRunner).not.toHaveBeenCalled();
    await expanded.close();
  });

  it("runs Setup and Notification through the shared Hook Session", async () => {
    const directory = await temporaryDirectory();
    const order: string[] = [];
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          Notification: () => {
            order.push("notification-hook");
            return { suppressOutput: true };
          },
          Setup: () => {
            order.push("setup-hook");
            return {};
          },
        }),
      },
      sessionId: "lifecycle",
      sessionsDir: directory,
      turnRunner: async () => "unused",
    });
    const sink = vi.fn();

    await session.setup("init", async () => {
      order.push("setup-operation");
    });
    await session.notify(
      {
        message: "done",
        type: "agent_completed",
      },
      sink,
    );

    expect(order).toEqual(["setup-hook", "setup-operation", "notification-hook"]);
    expect(sink).not.toHaveBeenCalled();
    await session.close();
  });

  it("supports provided Hook sessions, generated TODO adapters, and Hook signals", async () => {
    const directory = await temporaryDirectory();
    const engine = hookEngine({});
    const hookSession = new HookSession({ engine });
    const turnRunner = vi.fn(async (_prompt, options) => {
      expect(options.hooks?.hookSession).toBe(hookSession);
      expect(options.todoExecutor).toBeDefined();
      return "done";
    });
    const provided = new AgentSession({
      hooks: {
        engine,
        hookSession,
      },
      sessionsDir: directory,
      taskStore: new InMemoryTaskStore(),
      turnRunner,
    });
    await provided.submit("task");
    await provided.close();

    const signal = new AbortController().signal;
    const generated = new AgentSession({
      hooks: {
        engine: hookEngine({}),
      },
      sessionsDir: directory,
      signal,
      turnRunner: async () => "done",
    });
    await generated.submit("signal");
    await generated.close();
  });

  it("uses fallback Stop feedback and preserves bounded-stage history", async () => {
    const directory = await temporaryDirectory();
    let stops = 0;
    const turnRunner = vi.fn().mockResolvedValueOnce("draft").mockResolvedValueOnce("done");
    const session = new AgentSession({
      hooks: {
        engine: hookEngine({
          Stop: () => {
            stops += 1;
            return stops === 1 ? { action: "block" } : {};
          },
        }),
      },
      sessionsDir: directory,
      turnRunner,
    });

    await session.submit("start");
    expect(turnRunner).toHaveBeenNthCalledWith(2, "Continue working.", expect.anything());
    await session.close();

    const staged = new AgentSession({
      sessionsDir: directory,
      turnRunner: async () => {
        throw new AgentStageStopError({ stopReason: "max_turns" });
      },
    });
    await expect(staged.submit("bounded")).rejects.toBeInstanceOf(AgentStageStopError);
    expect(staged.historySnapshot()).toEqual([
      {
        content: "bounded",
        role: "user",
      },
    ]);
    await staged.close();
  });

  it("keeps the original failure when StopFailure Hook reporting also fails", async () => {
    const directory = await temporaryDirectory();
    const engine = hookEngine({});
    const hookSession = new HookSession({ engine });
    vi.spyOn(hookSession, "dispatch").mockImplementation(async (event) => {
      if (event.hook_event_name === "StopFailure") {
        throw new Error("hook failed");
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
    const session = new AgentSession({
      hooks: {
        engine,
        hookSession,
      },
      sessionsDir: directory,
      turnRunner: async () => {
        throw "original failure";
      },
    });

    await expect(session.submit("fail")).rejects.toBe("original failure");
    expect(await readFile(session.transcriptFilePath(), "utf8")).toContain(
      "StopFailure Hook failed: hook failed",
    );
    await session.close();
  });
});

function hookEngine(handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>): HookEngine {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, handler]) => [
      eventName,
      [
        {
          hooks: [
            {
              callback: handler,
              name: eventName,
              type: "callback",
            },
          ],
        },
      ],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: { hooks },
    },
  ]).snapshot;

  return new HookEngine({
    executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
    snapshot,
  });
}

function callback(events: HookEventName[], handler: HookCallback): HookCallback {
  return (invocation, context) => {
    events.push(invocation.event.hook_event_name);
    return handler(invocation, context);
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-agent-session-"));
  temporaryDirectories.push(directory);
  return directory;
}
