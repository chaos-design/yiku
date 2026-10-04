import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { MemoryStoreError } from "@yiku/memories";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_BUDGET_CONFIG } from "../../src/config/runtime-config.js";
import { AgentMessageBus } from "../../src/messages/message-bus.js";
import type { AgentMessageEnvelope } from "../../src/messages/types.js";
import type { SessionToolCheckpointStore } from "../../src/runtime/session-tool-middleware.js";
import { AgentStageStopError, SessionPausedError } from "../../src/session/execution-policy.js";
import { SessionRuntime, type SessionRuntimeSession } from "../../src/session/session-runtime.js";
import {
  createInitialSessionState,
  parseSessionState,
  type SessionState,
} from "../../src/session/session-state.js";
import { SessionStore } from "../../src/session/session-store.js";
import type { CheckpointSnapshotStore } from "../../src/workspace/checkpoint-service.js";
import { WorkspaceSnapshotLimitError } from "../../src/workspace/workspace-snapshot-store.js";

const TEST_ATOMIC_STUDIO_URL = "http://127.0.0.1:3333/tests";

describe("SessionRuntime", () => {
  it("exposes its current durable state snapshot", async () => {
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      session: fakeSession([]),
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    expect(runtime.stateSnapshot()).toBe(checkpoint.state);
    await runtime.close();
  });

  it("delegates Session operations and closes resources in reverse order", async () => {
    const calls: string[] = [];
    const session = fakeSession(calls);
    const runtime = new SessionRuntime({
      resources: [
        { close: () => calls.push("resource:first") },
        { close: async () => calls.push("resource:second") },
      ],
      session,
    });

    await expect(runtime.submit("prompt")).resolves.toBe("output:prompt");
    await expect(runtime.present("message")).resolves.toEqual({ message: "visible:message" });
    await runtime.clear();
    await runtime.close("prompt_input_exit");
    await runtime.close("other");

    expect(calls).toEqual([
      "session:submit",
      "session:notify",
      "session:present",
      "session:clear",
      "resource:second",
      "resource:first",
      "session:close:prompt_input_exit",
    ]);
    await expect(runtime.submit("late")).rejects.toThrow("Session Runtime is closed");
  });

  it("creates one Agent Session and rejects work while closing", async () => {
    let release: (() => void) | undefined;
    const session = fakeSession([]);
    session.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runtime = new SessionRuntime({ session });
    const closing = runtime.close();

    await expect(runtime.submit("late")).rejects.toThrow("Session Runtime is closing");
    release?.();
    await closing;
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("attempts every close and aggregates cleanup errors", async () => {
    const calls: string[] = [];
    const session = fakeSession(calls);
    session.close = vi.fn(async () => {
      calls.push("session");
      throw new Error("session close failed");
    });
    const runtime = new SessionRuntime({
      resources: [
        {
          close: () => {
            calls.push("first");
            throw new Error("first close failed");
          },
        },
        {
          close: () => {
            calls.push("second");
            throw new Error("second close failed");
          },
        },
      ],
      session,
    });

    await expect(runtime.close()).rejects.toThrow(AggregateError);
    expect(calls).toEqual(["second", "first", "session"]);
  });

  it("runs Setup and emits a completion Notification after submit", async () => {
    const calls: string[] = [];
    const notifications: string[] = [];
    const session = fakeSession(calls);
    const runtime = new SessionRuntime({
      notificationSink: (notification) => {
        notifications.push(notification.message);
      },
      session,
    });

    await runtime.setup("maintenance", async () => {
      calls.push("setup-operation");
    });
    await runtime.submit("prompt");

    expect(calls).toEqual([
      "session:setup:maintenance",
      "setup-operation",
      "session:submit",
      "session:notify",
    ]);
    expect(notifications).toEqual(["Agent run completed."]);
    await runtime.close();
  });

  it("keeps one submit pending until the active user question is answered", async () => {
    const events: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const atomicFlow = new AtomicFlowRun({ runId: "user-question" });
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const response = await options?.userQuestionHandler?.({
        options: ["PostgreSQL", "SQLite"],
        question: "Which database should we use?",
        toolCallId: "call-1",
      });
      return `selected ${response?.answer ?? "missing"}`;
    });
    const runtime = new SessionRuntime({ atomicFlow, session });

    const submitting = runtime.submit("design storage", {
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => {
      expect(runtime.pendingUserQuestions()).toHaveLength(1);
    });
    expect(session.submit).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        questionId: expect.any(String),
        request: expect.objectContaining({
          question: "Which database should we use?",
          toolCallId: "call-1",
        }),
        type: "user_question_requested",
      }),
    );

    const question = runtime.pendingUserQuestions()[0];
    expect(question).toBeDefined();
    runtime.answerUserQuestion(question?.questionId ?? "", {
      answer: "SQLite",
      selectedIndex: 1,
    });

    await expect(submitting).resolves.toBe("selected SQLite");
    expect(session.submit).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      questionId: question?.questionId,
      selectedIndex: 1,
      type: "user_question_resolved",
    });
    expect(runtime.pendingUserQuestions()).toEqual([]);
    expect(
      atomicFlow
        .snapshot()
        .events.filter((event) => event.atom.key === "user.question")
        .filter((event) => event.phase === "end")
        .map((event) => event.payload?.summary),
    ).toEqual(["requested", "resolved"]);
    await runtime.close();
    await atomicFlow.close();
  });

  it("routes the legacy question handler through the broker lifecycle", async () => {
    const events: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const legacyHandler = vi.fn(async () => ({ answer: "SQLite" }));
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const response = await options?.userQuestionHandler?.({
        question: "Which database should we use?",
      });
      return response?.answer ?? "missing";
    });
    const runtime = new SessionRuntime({ session });

    await expect(
      runtime.submit("design storage", {
        onEvent: (event) => events.push(event),
        userQuestionHandler: legacyHandler,
      }),
    ).resolves.toBe("SQLite");

    expect(legacyHandler).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["user_question_requested", "user_question_resolved"]),
    );
    await runtime.close();
  });

  it("cancels a pending user question without ending other broker requests", async () => {
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const first = options?.userQuestionHandler?.({ question: "First?" });
      const second = options?.userQuestionHandler?.({ question: "Second?" });
      const responses = await Promise.allSettled([first, second]);
      return responses.map((response) => response.status).join(",");
    });
    const runtime = new SessionRuntime({ session });
    const submitting = runtime.submit("ask twice");

    await vi.waitFor(() => {
      expect(runtime.pendingUserQuestions()).toHaveLength(2);
    });
    const [first, second] = runtime.pendingUserQuestions();
    runtime.cancelUserQuestion(first?.questionId ?? "", "Skip first.");
    expect(runtime.pendingUserQuestions()).toHaveLength(1);
    runtime.answerUserQuestion(second?.questionId ?? "", { answer: "Continue" });

    await expect(submitting).resolves.toBe("rejected,fulfilled");
    await runtime.close();
  });

  it("persists concurrent pending questions without dropping either record", async () => {
    const checkpoint = checkpointStore();
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const first = options?.userQuestionHandler?.({ question: "First?" });
      const second = options?.userQuestionHandler?.({ question: "Second?" });
      const responses = await Promise.all([first, second]);
      return responses.map((response) => response?.answer).join(",");
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });
    const submitting = runtime.submit("ask twice");

    await vi.waitFor(() => {
      expect(checkpoint.current().pendingInput).toMatchObject({
        kind: "question",
        questions: [{ request: { question: "First?" } }, { request: { question: "Second?" } }],
      });
    });
    const [first, second] = runtime.pendingUserQuestions();
    runtime.answerUserQuestion(first?.questionId ?? "", { answer: "one" });
    runtime.answerUserQuestion(second?.questionId ?? "", { answer: "two" });

    await expect(submitting).resolves.toBe("one,two");
    expect(checkpoint.current().pendingInput).toBeUndefined();
    await runtime.close();
  });

  it("excludes user question wait time from the stage deadline", async () => {
    vi.useFakeTimers();
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const response = options?.userQuestionHandler?.({ question: "Continue?" });
      const signal = options?.signal;
      if (response === undefined || signal === undefined) {
        throw new Error("Expected question handler and stage signal.");
      }
      return Promise.race([
        response.then((answer) => answer.answer),
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new AgentStageStopError({
                  stopReason: "timeout",
                }),
              ),
            { once: true },
          );
        }),
      ]);
    });
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      budgetConfig: {
        ...DEFAULT_RUNTIME_BUDGET_CONFIG,
        maxStageDurationMs: 100,
      },
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      const submitting = runtime.submit("wait for input");
      await flushMicrotasks();
      await flushMicrotasks();
      expect(runtime.pendingUserQuestions()).toHaveLength(1);
      expect(checkpoint.current()).toMatchObject({
        pendingInput: {
          kind: "question",
          questions: [
            {
              continuation: {
                adapter: "openai-agents",
                strategy: "reconstructed",
              },
              request: {
                question: "Continue?",
              },
            },
          ],
        },
        status: "paused",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(runtime.pendingUserQuestions()).toHaveLength(1);
      const questionId = runtime.pendingUserQuestions()[0]?.questionId ?? "";
      runtime.answerUserQuestion(questionId, { answer: "Continue" });

      await expect(submitting).resolves.toBe("Continue");
      expect(checkpoint.current().status).toBe("completed");
      expect(checkpoint.current().pendingInput).toBeUndefined();
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("reconstructs a persisted non-sensitive question after process restart", async () => {
    const events: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const checkpoint = checkpointStore(
      parseSessionState({
        ...initialState(),
        pendingInput: {
          kind: "question",
          questions: [
            {
              continuation: {
                adapter: "openai-agents",
                strategy: "reconstructed",
              },
              createdAt: "2026-08-01T00:00:00.000Z",
              questionId: "question-restored",
              request: {
                options: ["PostgreSQL", "SQLite"],
                question: "Which database should we use?",
                toolCallId: "call-1",
              },
              stageId: "stage-1",
              toolCallId: "call-1",
            },
          ],
        },
        status: "paused",
      }),
    );
    const session = fakeSession([]);
    session.submit = vi.fn(async (prompt) => prompt);
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      resumed: true,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(
      runtime.submit("Continue working from the saved Session.", {
        onEvent: (event) => events.push(event),
        userQuestionHandler: async () => ({ answer: "SQLite" }),
      }),
    ).resolves.toContain("User answer:\nSQLite");
    expect(session.submit).toHaveBeenCalledWith(
      expect.stringContaining("The original provider Tool Calls were not serialized or resumed."),
      expect.any(Object),
    );
    expect(checkpoint.current().pendingInput).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        continuation: "reconstructed-continuation",
        pendingInputIds: ["question-restored"],
        type: "session_resumed",
      }),
    );
    await runtime.close();
  });

  it("persists a pending question across a real Session Store restart", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "yiku-pending-question-"));
    const firstStore = new SessionStore({ sessionsDir });
    const initial = await firstStore.create(initialState());
    await firstStore.acquireLease(initial.sessionId);
    const firstSession = fakeSession([]);
    firstSession.submit = vi.fn(async (_prompt, options) => {
      const response = await options?.userQuestionHandler?.({
        options: ["PostgreSQL", "SQLite"],
        question: "Which database should we use?",
        toolCallId: "call-1",
      });
      return response?.answer ?? "missing";
    });
    const firstRuntime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      resources: [firstStore],
      session: firstSession,
      sessionState: initial,
      store: firstStore,
    });

    try {
      const submitting = firstRuntime.submit("design storage");
      await vi.waitFor(async () => {
        expect(await firstStore.load(initial.sessionId)).toMatchObject({
          pendingInput: {
            kind: "question",
            questions: [{ questionId: expect.any(String) }],
          },
          status: "paused",
        });
      });
      const rejected = expect(submitting).rejects.toThrow("Session Runtime closed");
      await firstRuntime.close("prompt_input_exit");
      await rejected;

      const secondStore = new SessionStore({ sessionsDir });
      const restored = await secondStore.load(initial.sessionId);
      await secondStore.acquireLease(restored.sessionId);
      const secondSession = fakeSession([]);
      secondSession.submit = vi.fn(async (prompt) => prompt);
      const secondRuntime = new SessionRuntime({
        budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
        resources: [secondStore],
        resumed: true,
        session: secondSession,
        sessionState: restored,
        store: secondStore,
      });

      await expect(
        secondRuntime.submit("continue", {
          userQuestionHandler: async () => ({ answer: "SQLite" }),
        }),
      ).resolves.toContain("User answer:\nSQLite");
      expect((await secondStore.load(initial.sessionId)).pendingInput).toBeUndefined();
      await secondRuntime.close();
    } finally {
      await firstRuntime.close().catch(() => undefined);
      await rm(sessionsDir, { force: true, recursive: true });
    }
  });

  it("keeps sensitive pending questions in needs-review after restart", async () => {
    const checkpoint = checkpointStore(
      parseSessionState({
        ...initialState(),
        pendingInput: {
          kind: "question",
          questions: [
            {
              continuation: {
                adapter: "openai-agents",
                strategy: "review-required",
              },
              createdAt: "2026-08-01T00:00:00.000Z",
              questionId: "question-secret",
              request: {
                questions: [
                  {
                    header: "Secret",
                    multiSelect: false,
                    options: [
                      {
                        description: "Use a reference",
                        label: "Reference",
                        optionId: "reference",
                      },
                      { description: "Cancel", label: "Cancel", optionId: "cancel" },
                    ],
                    question: "Provide credential access?",
                    questionKey: "code.credentials.access@1",
                    risk: "secret",
                  },
                ],
              },
              stageId: "stage-1",
            },
          ],
        },
        status: "paused",
      }),
    );
    const session = fakeSession([]);
    session.submit = vi.fn(async () => "unreachable");
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      resumed: true,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("continue")).rejects.toMatchObject({
      reason: "needs-review",
    });
    expect(session.submit).not.toHaveBeenCalled();
    expect(checkpoint.current()).toMatchObject({
      pendingInput: {
        kind: "question",
        questions: [{ questionId: "question-secret" }],
      },
      status: "needs-review",
    });
    await runtime.close();
  });

  it("aborts an active submit and clears pending questions when closed", async () => {
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const response = options?.userQuestionHandler?.({ question: "Continue?" });
      const signal = options?.signal;
      if (response === undefined || signal === undefined) {
        throw new Error("Expected question handler and submit signal.");
      }
      return Promise.race([
        response.then((answer) => answer.answer),
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    });
    const runtime = new SessionRuntime({ session });
    const submitting = runtime.submit("wait");
    await vi.waitFor(() => {
      expect(runtime.pendingUserQuestions()).toHaveLength(1);
    });

    const rejected = expect(submitting).rejects.toThrow(
      "Session Runtime closed during an active submit.",
    );
    await runtime.close();

    await rejected;
    expect(runtime.pendingUserQuestions()).toEqual([]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("continues max-turn stages with in-memory SDK state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-stage-continuation-"));
    const homeDir = await mkdtemp(join(tmpdir(), "yiku-stage-continuation-home-"));
    const calls: Array<{ readonly options: unknown; readonly prompt: string }> = [];
    const continuationState = { marker: "continuation" };
    const session = fakeSession([]);
    session.submit = vi
      .fn()
      .mockImplementationOnce(async (prompt, options) => {
        calls.push({ options, prompt });
        throw new AgentStageStopError({
          continuationState,
          stopReason: "max_turns",
        });
      })
      .mockImplementationOnce(async (prompt, options) => {
        calls.push({ options, prompt });
        return "done";
      });
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      cwd: directory,
      env: {
        YIKU_ATOMIC_STUDIO_URL: TEST_ATOMIC_STUDIO_URL,
      },
      homeDir,
      session,
      sessionId: "session-1",
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(runtime.submit("long task")).resolves.toBe("done");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        options: {
          continuationState,
        },
        prompt: "Continue working from the saved stage.",
      });
      expect(checkpoint.current()).toMatchObject({
        budget: {
          totalStages: 2,
        },
        status: "completed",
      });
      const firstOptions = calls[0]?.options as { atomicFlow?: unknown } | undefined;
      const secondOptions = calls[1]?.options as { atomicFlow?: unknown } | undefined;
      const firstAtomicFlow = firstOptions?.atomicFlow;
      expect(firstAtomicFlow).toBeDefined();
      expect(secondOptions?.atomicFlow).toBe(firstAtomicFlow);
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("creates a unique observed Atomic Run for each top-level submit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-observed-run-"));
    const runIds: string[] = [];
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const flow = (
        options as {
          readonly atomicFlow?: { readonly runId: string } | undefined;
        }
      ).atomicFlow;
      if (flow !== undefined) {
        runIds.push(flow.runId);
      }
      return "done";
    });
    const runtime = new SessionRuntime({
      cwd: directory,
      env: {
        YIKU_ATOMIC_STUDIO_URL: TEST_ATOMIC_STUDIO_URL,
      },
      session,
      sessionId: "session-1",
    });

    try {
      await runtime.submit("first");
      await runtime.submit("second");

      expect(runIds).toHaveLength(2);
      expect(runIds[0]).not.toBe(runIds[1]);
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies Flow Trace configuration to owned Atomic Runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-flow-trace-"));
    const homeDir = await mkdtemp(join(tmpdir(), "yiku-flow-trace-home-"));
    const eventKinds: string[] = [];
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const flow = options?.atomicFlow;
      if (flow === undefined) {
        throw new Error("Expected an owned Atomic Flow.");
      }
      flow
        .start({
          atom: {
            key: "loop.turn",
            kind: "loop",
            label: "Loop Turn",
            level: "runtime",
          },
        })
        .end();
      await flow.flush();
      eventKinds.push(...flow.snapshot().events.map((event) => event.atom.kind));
      return "done";
    });
    const runtime = new SessionRuntime({
      cwd: directory,
      flowConfig: {
        trace: true,
      },
      homeDir,
      session,
      sessionId: "session-1",
    });

    try {
      await runtime.submit("trace this");
      expect(eventKinds).toContain("trace");
      expect(eventKinds).not.toContain("trajectory");
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("emits bounded lifecycle, checkpoint, resume, and task events", async () => {
    const events: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const atomicFlow = new AtomicFlowRun({ runId: "lifecycle" });
    const checkpoint = checkpointStore({
      ...initialState(),
      tasks: [
        {
          id: "task-1",
          revision: 1,
          status: "completed",
          subject: "Done",
        },
      ],
    });
    const runtime = new SessionRuntime({
      atomicFlow,
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      resumed: true,
      session: fakeSession([]),
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await runtime.submit("continue", {
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "checkpoint_saved",
        "session_resumed",
        "stage_finished",
        "stage_started",
        "task_snapshot",
      ]),
    );
    expect(events.find((event) => event.type === "stage_started")).toMatchObject({
      stageId: "stage-1",
    });
    expect(atomicFlow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "session.checkpoint",
        "session.resume",
        "stage.finish",
        "stage.start",
        "task.snapshot",
      ]),
    );
    await runtime.close();
    await atomicFlow.close();
  });

  it("persists lifecycle, tool, and assistant envelopes before a durable submit returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-events-"));
    const legacyEvents: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const checkpoint = checkpointStore(
      parseSessionState({
        ...initialState(),
        eventLogPath: "logs/events.jsonl",
      }),
    );
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      options?.onEvent?.({
        agentName: "Code",
        model: "gpt-test",
        prompt: "persist events",
        sessionId: "session-1",
        startedAt: "2026-08-10T00:00:00.000Z",
        type: "session_started",
        workspaceDir: "/workspace",
      });
      options?.onEvent?.({
        callId: "tool-1",
        effect: "read",
        input: { path: "README.md" },
        summary: "read README.md",
        title: "Read",
        toolName: "readTool",
        type: "tool_called",
      });
      options?.onEvent?.({ text: "done", type: "message_delta" });
      options?.onEvent?.({
        callId: "tool-1",
        effect: "read",
        output: "contents",
        summary: "read README.md",
        title: "Read",
        toolName: "readTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        durationMs: 1,
        finishedAt: "2026-08-10T00:00:00.001Z",
        output: "done",
        sessionId: "session-1",
        type: "session_finished",
      });
      return "done";
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionsDir: directory,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(
        runtime.submit("persist events", {
          onEvent: (event) => {
            legacyEvents.push(event);
          },
        }),
      ).resolves.toBe("done");

      const messages = (await readFile(join(directory, "logs/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as AgentMessageEnvelope);
      expect(messages.map((message) => message.payload.kind)).toEqual(
        expect.arrayContaining([
          "assistant_delta",
          "session_lifecycle",
          "tool_called",
          "tool_output",
        ]),
      );
      expect(
        messages.every(
          (message) => message.agentId === "code" && message.sessionId === "session-1",
        ),
      ).toBe(true);
      for (const type of [
        "session_started",
        "tool_called",
        "message_delta",
        "tool_output",
        "session_finished",
      ] as const) {
        expect(legacyEvents.filter((event) => event.type === type)).toHaveLength(1);
      }
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("delivers native child messages before the submit callback unsubscribes", async () => {
    const requiredStarted = deferred();
    const releaseRequired = deferred();
    const messageBus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: async () => {
            requiredStarted.resolve();
            await releaseRequired.promise;
          },
        },
      ],
    });
    const childMessage: AgentMessageEnvelope = {
      agentId: "child-1",
      eventId: "child-event-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      parentAgentId: "root",
      payload: {
        agentType: "code",
        kind: "agent_spawned",
        profileId: "reviewer",
      },
      sessionId: "session-1",
      taskId: "task-1",
    };
    const session = fakeSession([]);
    session.submit = vi.fn(async () => {
      void messageBus.publish(childMessage);
      return "done";
    });
    const runtime = new SessionRuntime({
      messageBus,
      messageCorrelation: {
        agentId: "root",
        sessionId: "session-1",
      },
      session,
    });
    const onMessage = vi.fn();
    let submitSettled = false;

    const submitting = runtime.submit("delegate", { onMessage }).then((output) => {
      submitSettled = true;
      return output;
    });
    await requiredStarted.promise;
    expect(submitSettled).toBe(false);
    releaseRequired.resolve();

    await expect(submitting).resolves.toBe("done");
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(childMessage);

    await messageBus.publish({
      ...childMessage,
      eventId: "child-event-2",
      payload: { kind: "agent_finished", status: "succeeded" },
    });
    expect(onMessage).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it.each([
    ["parent traversal", "../outside.jsonl"],
    ["absolute path", join(tmpdir(), "outside.jsonl")],
    ["empty path", ""],
  ])("rejects a %s event log path during construction", async (_case, eventLogPath) => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-event-path-"));
    const checkpoint = checkpointStore({
      ...initialState(),
      eventLogPath,
    } as SessionState);

    try {
      expect(
        () =>
          new SessionRuntime({
            session: fakeSession([]),
            sessionsDir: directory,
            sessionState: checkpoint.state,
            store: checkpoint.store,
          }),
      ).toThrow("Session event log path");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("captures the pre-turn revision and history before invoking the Agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-checkpoint-"));
    const history = [{ content: "earlier", role: "user" as const }];
    const session = fakeSession([]);
    session.historySnapshot = () => history;
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    session.submit = vi.fn(async () => {
      expect(checkpoint.current().checkpointHead).toBe("checkpoint-1");
      return "done";
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(runtime.submit("next turn")).resolves.toBe("done");

      expect(snapshots.capture).toHaveBeenCalledWith({
        sessionId: "session-1",
        sessionRevision: checkpoint.state.revision,
      });
      await expect(runtime.checkpoints()).resolves.toEqual([
        expect.objectContaining({
          historyEntries: history,
          id: "checkpoint-1",
          prompt: "next turn",
          sessionRevision: checkpoint.state.revision,
        }),
      ]);
      expect(session.submit).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not invoke the Agent when the pre-turn snapshot fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-checkpoint-failure-"));
    const session = fakeSession([]);
    session.submit = vi.fn(async () => "not called");
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    snapshots.capture.mockRejectedValueOnce(new Error("snapshot failed"));
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(runtime.submit("blocked turn")).rejects.toThrow("snapshot failed");
      expect(session.submit).not.toHaveBeenCalled();
      expect(checkpoint.current().checkpointHead).toBeUndefined();
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("continues a turn without a checkpoint only after explicit high-risk approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-checkpoint-limit-allow-"));
    const session = fakeSession([]);
    session.submit = vi.fn(async () => "approved");
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    snapshots.capture.mockRejectedValueOnce(new WorkspaceSnapshotLimitError("bytes", 11, 10));
    const permissionApprovalHandler = vi.fn(async () => ({
      decision: "allow" as const,
      scope: "once" as const,
    }));
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(
        runtime.submit("large workspace turn", { permissionApprovalHandler }),
      ).resolves.toBe("approved");
      expect(permissionApprovalHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "execute without rewindable checkpoint",
          capabilities: ["workspace.checkpoint.bypass"],
          policyId: "workspace-checkpoint-limit",
          risk: "high",
          subject: "large workspace turn",
          toolName: "sessionTurn",
          workspaceId: "/workspace",
        }),
      );
      expect(session.submit).toHaveBeenCalledOnce();
      expect(checkpoint.current().checkpointHead).toBeUndefined();
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      approval: undefined,
      case: "missing approval handler",
      message: "No permission approval handler configured",
    },
    {
      approval: vi.fn(async () => ({ decision: "deny" as const, reason: "keep rewind safety" })),
      case: "explicit denial",
      message: "keep rewind safety",
    },
  ])("blocks a snapshot-limit turn after $case", async ({ approval, message }) => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-checkpoint-limit-deny-"));
    const session = fakeSession([]);
    session.submit = vi.fn(async () => "not called");
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    snapshots.capture.mockRejectedValueOnce(new WorkspaceSnapshotLimitError("files", 2, 1));
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await expect(
        runtime.submit("blocked large turn", {
          ...(approval === undefined ? {} : { permissionApprovalHandler: approval }),
        }),
      ).rejects.toThrow(message);
      expect(session.submit).not.toHaveBeenCalled();
      expect(checkpoint.current().checkpointHead).toBeUndefined();
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("restores workspace, history, and durable checkpoint state on rewind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-rewind-"));
    let history = [{ content: "before", role: "user" as const }];
    const session = fakeSession([]);
    session.historySnapshot = () => history;
    session.restoreHistory = vi.fn((entries) => {
      history = [...entries];
    });
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await runtime.submit("change workspace");
      const record = (await runtime.checkpoints())[0];
      expect(record).toBeDefined();
      history = [{ content: "after", role: "assistant" }];

      await runtime.rewind(record?.id ?? "");

      expect(snapshots.restore).toHaveBeenCalledWith(record?.id);
      expect(session.restoreHistory).toHaveBeenCalledWith(record?.historyEntries);
      expect(checkpoint.current()).toMatchObject({
        checkpointHead: record?.id,
        history: {
          entries: record?.historyEntries,
        },
        status: "active",
      });
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not change history or state when workspace rewind fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-rewind-failure-"));
    let history = [{ content: "before", role: "user" as const }];
    const session = fakeSession([]);
    session.historySnapshot = () => history;
    session.restoreHistory = vi.fn((entries) => {
      history = [...entries];
    });
    const checkpoint = checkpointStore();
    const snapshots = checkpointSnapshotStore();
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      checkpointSnapshotStore: snapshots.store,
      indexFilePath: join(directory, "session-1.checkpoints.json"),
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    try {
      await runtime.submit("change workspace");
      const record = (await runtime.checkpoints())[0];
      history = [{ content: "current", role: "assistant" }];
      const current = await checkpoint.store.load("session-1");
      await checkpoint.store.update("session-1", current.revision, (state) =>
        parseSessionState({
          ...state,
          history: {
            entries: history,
          },
        }),
      );
      const stateBeforeRewind = checkpoint.current();
      snapshots.restore.mockRejectedValueOnce(new Error("restore failed"));

      await expect(runtime.rewind(record?.id ?? "")).rejects.toThrow("restore failed");

      expect(session.restoreHistory).not.toHaveBeenCalled();
      expect(history).toEqual([{ content: "current", role: "assistant" }]);
      expect(checkpoint.current()).toBe(stateBeforeRewind);
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("pauses when the stage budget is exhausted", async () => {
    const session = fakeSession([]);
    session.submit = vi.fn(async () => {
      throw new AgentStageStopError({
        continuationState: { marker: "continuation" },
        stopReason: "max_turns",
      });
    });
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      budgetConfig: {
        ...DEFAULT_RUNTIME_BUDGET_CONFIG,
        maxStagesPerEpoch: 1,
      },
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("long task")).rejects.toBeInstanceOf(SessionPausedError);
    expect(checkpoint.current().status).toBe("paused");
    await runtime.close();
  });

  it("pauses durable sessions on strict Memory failures", async () => {
    const session = fakeSession([]);
    session.submit = vi.fn(async () => {
      throw new MemoryStoreError("MEMORY_STORE_UNAVAILABLE", "offline");
    });
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("remember")).rejects.toMatchObject({
      name: "SessionPausedError",
      reason: "memory-error",
    });
    expect(checkpoint.current().status).toBe("paused");
    await runtime.close();
  });

  it("compacts context before continuing a high-usage stage", async () => {
    let history = [{ content: "x".repeat(4_000), role: "user" as const }];
    const session = fakeSession([]);
    session.compact = vi.fn(async () => {
      history = [{ content: "summary", role: "system" }];
    });
    session.historySnapshot = () => history;
    session.submit = vi
      .fn()
      .mockImplementationOnce(async (_prompt, options) => {
        options?.onContext?.({
          agentKey: "code",
          agentName: "Code",
          apiKeyEnv: "OPENAI_API_KEY",
          contextWindow: 1_000,
          hasInstructions: true,
          model: "gpt-test",
          modelKey: "default",
          prompt: "long task",
          sessionId: "session-1",
          sessionsDir: "/workspace/.yiku/sessions",
          traceFilePath: "/workspace/.yiku/sessions/session-1.jsonl",
          transcriptFilePath: "/workspace/.yiku/sessions/session-1.transcript.jsonl",
          workspaceDir: "/workspace",
        });
        options?.onEvent?.({
          model: "gpt-test",
          type: "usage_updated",
          usage: {
            cachedInputTokens: 0,
            inputTokens: 700,
            outputTokens: 10,
            peakInputTokens: 700,
            totalTokens: 710,
          },
        });
        throw new AgentStageStopError({
          continuationState: { marker: "continuation" } as never,
          stopReason: "max_turns",
        });
      })
      .mockResolvedValueOnce("done");
    const checkpoint = checkpointStore();
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    const events: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    await expect(
      runtime.submit("long task", {
        onEvent: (event) => events.push(event),
      }),
    ).resolves.toBe("done");
    expect(session.compact).toHaveBeenCalledWith("auto", 1_000);
    expect(checkpoint.current().history.entries).toEqual([{ content: "summary", role: "system" }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          afterEntries: 1,
          beforeEntries: 1,
          type: "context_compacted",
        }),
      ]),
    );
    await runtime.close();
  });

  it("requires review for uncertain side effects and applies the decision", async () => {
    const operation = {
      callId: "call-1",
      effect: "external" as const,
      inputSummary: "create issue",
      stageId: "stage-1",
      startedAt: "2026-08-01T00:00:00.000Z",
      toolName: "mcp__github__create_issue",
    };
    const checkpoint = checkpointStore({
      ...initialState(),
      inFlightOperations: [operation],
      status: "needs-review",
    });
    const session = fakeSession([]);
    const review = vi.fn(async () => ({ action: "completed" as const }));
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("continue", { resumeReviewHandler: review })).resolves.toBe(
      "output:continue",
    );
    expect(review).toHaveBeenCalledWith({ operation });
    expect(checkpoint.current()).toMatchObject({
      inFlightOperations: [],
      lastCompletedOperation: {
        callId: "call-1",
        status: "succeeded",
      },
      status: "completed",
    });
    await runtime.close();
  });

  it("fails closed without side-effect review and clears read-only calls automatically", async () => {
    const sideEffect = checkpointStore({
      ...initialState(),
      inFlightOperations: [
        {
          callId: "call-1",
          effect: "process",
          inputSummary: "run command",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:00.000Z",
          toolName: "bashTool",
        },
      ],
      status: "needs-review",
    });
    const blocked = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session: fakeSession([]),
      sessionState: sideEffect.state,
      store: sideEffect.store,
    });
    await expect(blocked.submit("continue")).rejects.toMatchObject({
      name: "SessionPausedError",
      reason: "needs-review",
    });
    await blocked.close();

    const read = checkpointStore({
      ...initialState(),
      inFlightOperations: [
        {
          callId: "call-2",
          effect: "read",
          inputSummary: "search",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:00.000Z",
          toolName: "grepTool",
        },
      ],
      status: "needs-review",
    });
    const resumed = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session: fakeSession([]),
      sessionState: read.state,
      store: read.store,
    });
    await expect(resumed.submit("continue")).resolves.toBe("output:continue");
    expect(read.current().inFlightOperations).toEqual([]);
    await resumed.close();
  });

  it("continues completed model stages while durable tasks remain unfinished", async () => {
    const checkpoint = checkpointStore({
      ...initialState(),
      tasks: [
        {
          id: "task-1",
          revision: 1,
          status: "pending",
          subject: "Run tests",
        },
      ],
    });
    const session = fakeSession([]);
    session.submit = vi
      .fn()
      .mockResolvedValueOnce("draft")
      .mockImplementationOnce(async () => {
        const current = checkpoint.current();
        await checkpoint.store.update(current.sessionId, current.revision, (state) => ({
          ...state,
          budget: {
            ...state.budget,
            progressRevision: state.budget.progressRevision + 1,
          },
          tasks: [
            {
              ...state.tasks[0],
              revision: 2,
              status: "completed",
            },
          ],
        }));
        return "done";
      });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("finish tasks")).resolves.toBe("done");
    expect(session.submit).toHaveBeenNthCalledWith(
      2,
      "Continue working from the persisted task list.",
      expect.anything(),
    );
    expect(checkpoint.current().status).toBe("completed");
    await runtime.close();
  });

  it("validates durable configuration and rejects concurrent submits", async () => {
    expect(
      () =>
        new SessionRuntime({
          session: fakeSession([]),
          sessionState: initialState(),
        }),
    ).toThrow("state and store must be configured together");
    expect(
      () =>
        new SessionRuntime({
          session: fakeSession([]),
          store: checkpointStore().store,
        }),
    ).toThrow("state and store must be configured together");

    let release: (() => void) | undefined;
    const session = fakeSession([]);
    session.submit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        }),
    );
    const runtime = new SessionRuntime({ session });
    const first = runtime.submit("first");

    await expect(runtime.submit("second")).rejects.toThrow("active submit");
    release?.();
    await expect(first).resolves.toBe("done");
    await runtime.close();
  });

  it("marks provider failures as failed and blocked tasks as paused", async () => {
    const failedCheckpoint = checkpointStore();
    const failedSession = fakeSession([]);
    failedSession.submit = vi.fn(async () => {
      throw new Error("provider offline");
    });
    const failedEvents: import("../../src/runtime/types.js").AgentProgressEvent[] = [];
    const failed = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session: failedSession,
      sessionState: failedCheckpoint.state,
      store: failedCheckpoint.store,
    });

    await expect(
      failed.submit("fail", {
        onEvent: (event) => failedEvents.push(event),
      }),
    ).rejects.toThrow("provider offline");
    expect(failedCheckpoint.current().status).toBe("failed");
    expect(failedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: "provider_error",
          type: "stage_finished",
        }),
      ]),
    );
    await failed.close();

    const blockedCheckpoint = checkpointStore({
      ...initialState(),
      tasks: [
        {
          id: "task-1",
          revision: 1,
          status: "blocked",
          subject: "Blocked",
        },
      ],
    });
    const blocked = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session: fakeSession([]),
      sessionState: blockedCheckpoint.state,
      store: blockedCheckpoint.store,
    });
    await expect(blocked.submit("blocked")).rejects.toMatchObject({
      reason: "blocked-task",
    });
    expect(blockedCheckpoint.current().status).toBe("paused");
    await blocked.close();
  });

  it("records abandon and retry review decisions", async () => {
    const operations = [
      {
        callId: "call-abandon",
        effect: "write" as const,
        inputSummary: "edit",
        stageId: "stage-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        toolName: "textEditorTool",
      },
      {
        callId: "call-retry",
        effect: "process" as const,
        inputSummary: "command",
        stageId: "stage-1",
        startedAt: "2026-08-01T00:00:01.000Z",
        toolName: "bashTool",
      },
    ];
    const checkpoint = checkpointStore({
      ...initialState(),
      inFlightOperations: operations,
      status: "needs-review",
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session: fakeSession([]),
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await runtime.submit("continue", {
      resumeReviewHandler: ({ operation }) => ({
        action: operation.callId === "call-abandon" ? "abandon" : "retry",
      }),
    });
    expect(checkpoint.current()).toMatchObject({
      inFlightOperations: [],
      lastCompletedOperation: {
        callId: "call-abandon",
        status: "failed",
      },
    });
    await runtime.close();
  });

  it("pauses when a bounded stage leaves an external call in flight", async () => {
    const checkpoint = checkpointStore();
    const session = fakeSession([]);
    session.submit = vi.fn(async () => {
      const current = checkpoint.current();
      await checkpoint.store.update(current.sessionId, current.revision, (state) => ({
        ...state,
        inFlightOperations: [
          {
            callId: "call-1",
            effect: "external",
            inputSummary: "remote write",
            stageId: "stage-1",
            startedAt: "2026-08-01T00:00:00.000Z",
            toolName: "mcp__remote__write",
          },
        ],
      }));
      throw new AgentStageStopError({
        stopReason: "max_turns",
      });
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    await expect(runtime.submit("write")).rejects.toMatchObject({
      reason: "needs-review",
    });
    expect(checkpoint.current().status).toBe("needs-review");
    await runtime.close();
  });

  it("constructs the owned AgentSession, Trace, TaskStore, and checkpoint middleware", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-owned-runtime-"));
    const homeDir = await mkdtemp(join(tmpdir(), "yiku-owned-runtime-home-"));
    const checkpoint = checkpointStore();
    const turnRunner = vi.fn(async (_prompt, options) => {
      expect(options).toMatchObject({
        cwd: directory,
        sessionId: "session-1",
        sessionsDir: directory,
        toolCheckpointStore: checkpoint.store,
      });
      expect(options.taskStore).toBeDefined();
      expect(options.trace).toBeDefined();
      return "owned";
    });
    const runtime = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      cwd: directory,
      homeDir,
      maxParallelReaders: 2,
      sessionId: "session-1",
      sessionsDir: directory,
      sessionState: checkpoint.state,
      store: checkpoint.store,
      turnRunner,
    });

    try {
      await expect(runtime.submit("owned")).resolves.toBe("owned");
      expect(turnRunner).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
      await rm(homeDir, { force: true, recursive: true });
    }
  });

  it("captures structured Working Memory throughout a durable Session", async () => {
    const lifecycle = {
      captureWorking: vi.fn(async (input) => ({
        content: input.content,
        createdAt: "2026-08-07T00:00:00.000Z",
        id: `working-${input.source}`,
        sessionId: input.sessionId,
        source: input.source,
        status: "active",
        updatedAt: "2026-08-07T00:00:00.000Z",
      })),
      clearWorking: vi.fn(async () => []),
    };
    const initial = parseSessionState({
      ...initialState(),
      lastCompletedOperation: {
        callId: "call-1",
        completedAt: "2026-08-07T00:00:00.000Z",
        effect: "write",
        inputSummary: "Update file",
        outputSummary: "Updated",
        stageId: "stage-1",
        status: "succeeded",
        toolName: "Edit",
      },
      tasks: [
        {
          id: "task-1",
          revision: 1,
          status: "completed",
          subject: "Implement memory",
        },
      ],
    });
    const checkpoint = checkpointStore(initial);
    const session = fakeSession([]);
    session.submit = vi.fn(async (_prompt, options) => {
      const response = options?.userQuestionHandler?.({ question: "Continue?" });
      return response === undefined ? "missing" : (await response).answer;
    });
    const flow = new AtomicFlowRun({ runId: "working-capture" });
    const runtime = new SessionRuntime({
      atomicFlow: flow,
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      memories: {
        context: { namespace: "project" },
        lifecycle,
        manager: {},
      } as never,
      session,
      sessionState: checkpoint.state,
      store: checkpoint.store,
    });

    const submitting = runtime.submit("Capture goal");
    await vi.waitFor(() => {
      expect(runtime.pendingUserQuestions()).toHaveLength(1);
    });
    runtime.answerUserQuestion(runtime.pendingUserQuestions()[0]?.questionId ?? "", {
      answer: "Continue",
    });
    await expect(submitting).resolves.toBe("Continue");
    await flushMicrotasks();

    expect(lifecycle.captureWorking.mock.calls.map(([input]) => input.source)).toEqual(
      expect.arrayContaining(["prompt", "user-answer", "operation", "task"]),
    );
    expect(lifecycle.captureWorking).toHaveBeenCalledWith(
      expect.objectContaining({
        atomicFlow: flow,
        content: "Capture goal",
        sessionId: "session-1",
      }),
    );
    await runtime.clear();
    await runtime.close("prompt_input_exit");
    expect(lifecycle.clearWorking).toHaveBeenCalledTimes(2);
    await flow.close();
  });

  it("applies best-effort and strict behavior to Working Memory capture failures", async () => {
    const onError = vi.fn(() => {
      throw new Error("reporting failed");
    });
    const lifecycle = {
      captureWorking: vi.fn(async () => Promise.reject(new Error("offline"))),
      clearWorking: vi.fn(async () => []),
    };
    const bestEffortCheckpoint = checkpointStore();
    const bestEffort = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      memories: {
        context: { namespace: "project" },
        lifecycle,
        manager: {},
        onError,
      } as never,
      session: fakeSession([]),
      sessionState: bestEffortCheckpoint.state,
      store: bestEffortCheckpoint.store,
    });

    await expect(bestEffort.submit("continue")).resolves.toBe("output:continue");
    expect(onError).toHaveBeenCalled();
    await bestEffort.close();

    const strictCheckpoint = checkpointStore();
    const strict = new SessionRuntime({
      budgetConfig: DEFAULT_RUNTIME_BUDGET_CONFIG,
      memories: {
        context: { namespace: "project" },
        failureMode: "strict",
        lifecycle,
        manager: {},
      } as never,
      session: fakeSession([]),
      sessionState: strictCheckpoint.state,
      store: strictCheckpoint.store,
    });
    await expect(strict.submit("fail")).rejects.toThrow("offline");
    await strict.close();
  });
});

function fakeSession(calls: string[]): SessionRuntimeSession & {
  close: ReturnType<typeof vi.fn<SessionRuntimeSession["close"]>>;
} {
  return {
    clear: async () => {
      calls.push("session:clear");
    },
    close: vi.fn(async (reason) => {
      calls.push(`session:close:${reason}`);
    }),
    compact: vi.fn(async () => undefined),
    historySnapshot: () => [],
    present: async (message) => {
      calls.push("session:present");
      return { message: `visible:${message}` };
    },
    notify: async (notification, sink) => {
      calls.push("session:notify");
      await sink(notification);
    },
    setup: async (trigger, operation) => {
      calls.push(`session:setup:${trigger}`);
      return { result: await operation() };
    },
    submit: async (prompt) => {
      calls.push("session:submit");
      return `output:${prompt}`;
    },
  };
}

function checkpointStore(initial = initialState()): {
  readonly current: () => SessionState;
  readonly state: SessionState;
  readonly store: SessionToolCheckpointStore;
} {
  let current = initial;
  const store: SessionToolCheckpointStore = {
    load: async () => current,
    update: async (_sessionId, expectedRevision, update) => {
      if (current.revision !== expectedRevision) {
        throw new Error("revision conflict");
      }
      current = {
        ...update(current),
        revision: current.revision + 1,
      };
      return current;
    },
  };
  return {
    current: () => current,
    state: current,
    store,
  };
}

function initialState(): SessionState {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "config-v1",
    modelKey: "default",
    now: "2026-08-01T00:00:00.000Z",
    sessionId: "session-1",
    workspaceDir: "/workspace",
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function checkpointSnapshotStore(): {
  readonly capture: ReturnType<typeof vi.fn<CheckpointSnapshotStore["capture"]>>;
  readonly restore: ReturnType<typeof vi.fn<CheckpointSnapshotStore["restore"]>>;
  readonly store: CheckpointSnapshotStore;
} {
  const manifests = new Map<string, Awaited<ReturnType<CheckpointSnapshotStore["capture"]>>>();
  const capture = vi.fn<CheckpointSnapshotStore["capture"]>(async (input) => {
    const id = `checkpoint-${manifests.size + 1}`;
    const manifest = {
      createdAt: "2026-08-10T00:00:00.000Z",
      entries: [],
      id,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      version: 1 as const,
      ...(input.eventHead === undefined ? {} : { eventHead: input.eventHead }),
    };
    manifests.set(id, manifest);
    return manifest;
  });
  const load = vi.fn<CheckpointSnapshotStore["load"]>(async (id) => {
    const manifest = manifests.get(id);
    if (manifest === undefined) {
      throw new Error(`missing snapshot: ${id}`);
    }
    return manifest;
  });
  const restore = vi.fn<CheckpointSnapshotStore["restore"]>(async () => undefined);

  return {
    capture,
    restore,
    store: {
      capture,
      load,
      restore,
    },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}
