import { describe, expect, it } from "vitest";
import {
  createInitialSessionState,
  parseSessionState,
  SESSION_STATE_SCHEMA_VERSION,
} from "../../src/session/session-state.js";

describe("SessionState", () => {
  it("creates a deeply frozen initial state", () => {
    const state = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });

    expect(state).toEqual({
      agentKey: "code",
      budget: {
        epoch: 1,
        noProgressStages: 0,
        progressRevision: 0,
        stage: 0,
        toolCalls: 0,
        totalStages: 0,
      },
      configFingerprint: "config-v1",
      createdAt: "2026-08-01T00:00:00.000Z",
      eventLogPath: "session-1.events.jsonl",
      history: {
        entries: [],
      },
      inFlightOperations: [],
      modelKey: "default",
      outputStyle: "default",
      revision: 1,
      schemaVersion: SESSION_STATE_SCHEMA_VERSION,
      sessionId: "session-1",
      status: "active",
      subagentInstances: [],
      subagentProfiles: [],
      subagents: [],
      tasks: [],
      updatedAt: "2026-08-01T00:00:00.000Z",
      workingMemories: [],
      workspaceDir: "/workspace",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.budget)).toBe(true);
    expect(Object.isFrozen(state.history.entries)).toBe(true);
  });

  it("parses valid persisted state and rejects unknown or unsafe structure", () => {
    const state = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });

    expect(parseSessionState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => parseSessionState({ ...state, secret: "value" })).toThrow("Unrecognized key");
    expect(() => parseSessionState({ ...state, revision: 0 })).toThrow();
    expect(() => parseSessionState({ ...state, status: "unknown" })).toThrow();
    expect(() => parseSessionState({ ...state, updatedAt: "not-a-date" })).toThrow();
  });

  it("accepts bounded v4 presentation and checkpoint fields", () => {
    const state = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });

    for (const outputStyle of ["default", "compact", "verbose"] as const) {
      expect(
        parseSessionState({
          ...state,
          checkpointHead: "checkpoint-1",
          eventLogPath: "logs/session-1.events.jsonl",
          outputStyle,
          title: " Session title ",
        }),
      ).toMatchObject({
        checkpointHead: "checkpoint-1",
        eventLogPath: "logs/session-1.events.jsonl",
        outputStyle,
        title: "Session title",
      });
    }

    expect(() => parseSessionState({ ...state, checkpointHead: "x".repeat(257) })).toThrow();
    expect(() => parseSessionState({ ...state, eventLogPath: "" })).toThrow();
    expect(() => parseSessionState({ ...state, outputStyle: "expanded" })).toThrow();
    expect(() => parseSessionState({ ...state, title: "x".repeat(201) })).toThrow();
  });

  it("accepts bounded operation, task, subagent, and pending-input records", () => {
    const state = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });
    const parsed = parseSessionState({
      ...state,
      inFlightOperations: [
        {
          callId: "call-1",
          effect: "external",
          inputSummary: "create issue",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:01.000Z",
          toolName: "mcp__github__create_issue",
        },
      ],
      pendingInput: {
        kind: "side-effect-review",
        message: "Confirm the previous operation.",
      },
      subagents: [
        {
          agentKey: "reviewer",
          id: "agent-1",
          status: "running",
          taskId: "task-1",
        },
      ],
      tasks: [
        {
          id: "task-1",
          revision: 1,
          status: "in_progress",
          subject: "Review code",
        },
      ],
    });

    expect(parsed.inFlightOperations[0]?.effect).toBe("external");
    expect(parsed.tasks[0]?.subject).toBe("Review code");
    expect(parsed.subagents[0]?.status).toBe("running");
  });

  it("persists a bounded pending question without an answer payload", () => {
    const state = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });

    const parsed = parseSessionState({
      ...state,
      pendingInput: {
        kind: "question",
        questions: [
          {
            continuation: {
              adapter: "openai-agents",
              strategy: "reconstructed",
            },
            createdAt: "2026-08-01T00:00:01.000Z",
            questionId: "question-1",
            request: {
              options: ["PostgreSQL", "SQLite"],
              question: "Which database?",
              toolCallId: "call-1",
            },
            stageId: "stage-1",
            toolCallId: "call-1",
          },
        ],
      },
      status: "paused",
    });

    expect(parsed.pendingInput).toMatchObject({
      kind: "question",
      questions: [
        {
          questionId: "question-1",
          request: {
            question: "Which database?",
          },
        },
      ],
    });
    expect(JSON.stringify(parsed.pendingInput)).not.toContain("answer");
    expect(() =>
      parseSessionState({
        ...state,
        pendingInput: {
          kind: "question",
          questions: [
            {
              continuation: {
                adapter: "openai-agents",
                strategy: "reconstructed",
              },
              createdAt: "2026-08-01T00:00:01.000Z",
              questionId: "question-1",
              request: { question: "First?" },
              stageId: "stage-1",
            },
            {
              continuation: {
                adapter: "openai-agents",
                strategy: "reconstructed",
              },
              createdAt: "2026-08-01T00:00:02.000Z",
              questionId: "question-1",
              request: { question: "Second?" },
              stageId: "stage-1",
            },
          ],
        },
      }),
    ).toThrow("Pending question IDs must be unique");

    for (const [request, message] of [
      [null, "Pending question request must be an object"],
      [{ question: "Continue?", unknown: true }, "unknown field"],
      [{ question: "Continue?", toolCallId: "" }, "toolCallId must be"],
      [{ question: "Continue?", toolCallId: 123 }, "toolCallId must be"],
      [{ question: "Continue?", toolCallId: "x".repeat(257) }, "toolCallId must be"],
    ] as const) {
      expect(() =>
        parseSessionState({
          ...state,
          pendingInput: {
            kind: "question",
            questions: [
              {
                continuation: {
                  adapter: "openai-agents",
                  strategy: "reconstructed",
                },
                createdAt: "2026-08-01T00:00:01.000Z",
                questionId: "question-invalid",
                request,
                stageId: "stage-1",
              },
            ],
          },
        }),
      ).toThrow(message);
    }
  });
});
