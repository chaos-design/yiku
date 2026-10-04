import { describe, expect, it } from "vitest";
import {
  envelopeToProgressEvent,
  progressEventToEnvelope,
} from "../../src/messages/progress-adapter.js";
import type { AgentProgressEvent } from "../../src/runtime/types.js";

const correlation = {
  agentId: "root",
  sessionId: "session-1",
} as const;

const metadata = {
  eventId: "event-1",
  occurredAt: "2026-08-10T00:00:00.000Z",
} as const;

const allProgressEvents = [
  {
    checkpointRevision: 4,
    sessionStatus: "active",
    stageId: "stage-1",
    type: "checkpoint_saved",
  },
  {
    afterEntries: 3,
    beforeEntries: 9,
    type: "context_compacted",
  },
  {
    findings: [
      {
        code: "instruction-override",
        segmentIndex: 0,
        severity: "warning",
        source: "workspace",
        sourceId: "README.md",
        trust: "untrusted",
      },
    ],
    type: "prompt_risk_detected",
  },
  {
    attempts: 1,
    counts: { error: 0, failed: 0, "not-run": 0, passed: 5 },
    decision: "accepted",
    failedChecks: [],
    grade: "A",
    overallScore: 0.9,
    type: "evaluation_finished",
  },
  {
    continuation: "reconstructed-continuation",
    inFlightOperations: 2,
    pendingInputIds: ["question-1"],
    sessionId: "session-1",
    type: "session_resumed",
  },
  {
    stage: 1,
    stageId: "stage-1",
    totalStages: 3,
    type: "stage_started",
  },
  {
    outcome: "paused",
    reason: "needs-review",
    stageId: "stage-1",
    type: "stage_finished",
  },
  {
    blocked: 1,
    completed: 2,
    inProgress: 3,
    pending: 4,
    type: "task_snapshot",
  },
  {
    action: "created",
    agentType: "code",
    profileId: "profile-1",
    type: "agent_profile_changed",
  },
  {
    agentId: "child",
    agentType: "code",
    parentAgentId: "root",
    parentSessionId: "session-1",
    profileId: "profile-1",
    taskId: "task-1",
    type: "subagent_spawned",
  },
  {
    agentId: "child",
    output: "review complete",
    profileId: "profile-1",
    taskId: "task-1",
    type: "subagent_output",
  },
  {
    agentId: "child",
    profileId: "profile-1",
    status: "succeeded",
    taskId: "task-1",
    type: "subagent_result",
  },
  {
    digest: "abc123",
    name: "review",
    source: "project",
    type: "skill_resolved",
  },
  {
    name: "review",
    targetId: "child",
    type: "skill_activated",
  },
  {
    name: "review",
    type: "skill_worker_started",
    workerId: "worker-1",
  },
  {
    name: "review",
    status: "succeeded",
    type: "skill_worker_finished",
    workerId: "worker-1",
  },
  {
    agentName: "Code Agent",
    model: "gpt-test",
    prompt: "Implement the adapter",
    sessionId: "session-1",
    startedAt: "2026-08-10T00:00:00.000Z",
    type: "session_started",
    workspaceDir: "/workspace",
  },
  {
    questionId: "question-1",
    request: {
      options: ["Yes", "No"],
      question: "Continue?",
      toolCallId: "question-call",
    },
    type: "user_question_requested",
  },
  {
    questionId: "question-1",
    selectedIndex: 0,
    type: "user_question_resolved",
  },
  {
    questionId: "question-1",
    reason: "Session ended",
    type: "user_question_cancelled",
  },
  {
    text: "Hello",
    type: "message_delta",
  },
  {
    counts: {
      selected: 2,
    },
    durationMs: 4,
    endedAt: "2026-08-10T00:00:00.004Z",
    namespaceHash: "a1b2c3d4e5f6a7b8",
    operation: "recall",
    operationId: "memory-1",
    phase: "end",
    startedAt: "2026-08-10T00:00:00.000Z",
    type: "memory_operation",
  },
  {
    from: "sandbox",
    reason: "sandbox unavailable",
    to: "host-policy",
    type: "runtime_boundary_changed",
  },
  {
    callId: "read-call",
    effect: "read",
    input: { path: "src/index.ts" },
    summary: "view src/index.ts",
    title: "Read",
    toolName: "readTool",
    type: "tool_called",
  },
  {
    callId: "read-call",
    effect: "read",
    output: "contents",
    summary: "read src/index.ts",
    title: "Read",
    toolName: "readTool",
    type: "tool_output",
  },
  {
    type: "reasoning",
  },
  {
    agentId: "code",
    agentName: "Code Agent",
    type: "agent_updated",
  },
  {
    sourceAgentName: "Triage Agent",
    targetAgentName: "Code Agent",
    type: "handoff",
  },
  {
    model: "gpt-test",
    type: "usage_updated",
    usage: {
      cachedInputTokens: 1,
      inputTokens: 2,
      outputTokens: 3,
      peakInputTokens: 2,
      totalTokens: 5,
    },
  },
  {
    durationMs: 100,
    finishedAt: "2026-08-10T00:00:00.100Z",
    output: "done",
    sessionId: "session-1",
    type: "session_finished",
  },
  {
    durationMs: 100,
    error: "failed",
    finishedAt: "2026-08-10T00:00:00.100Z",
    sessionId: "session-1",
    source: "runner",
    stack: "stack",
    type: "session_failed",
  },
] satisfies readonly AgentProgressEvent[];

describe("legacy progress adapters", () => {
  it("maps user-visible content to dedicated payloads without changing values", () => {
    expect(
      progressEventToEnvelope({ text: "Hello", type: "message_delta" }, correlation, metadata),
    ).toEqual({
      agentId: "root",
      eventId: "event-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      payload: { kind: "assistant_delta", text: "Hello" },
      sessionId: "session-1",
    });

    expect(
      progressEventToEnvelope(
        {
          callId: "read-call",
          effect: "read",
          input: { path: "src/index.ts" },
          summary: "view src/index.ts",
          title: "Read",
          toolName: "readTool",
          type: "tool_called",
        },
        correlation,
        metadata,
      ),
    ).toEqual({
      agentId: "root",
      eventId: "event-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      payload: {
        effect: "read",
        input: { path: "src/index.ts" },
        kind: "tool_called",
        summary: "view src/index.ts",
        title: "Read",
        toolName: "readTool",
      },
      sessionId: "session-1",
      toolCallId: "read-call",
    });

    expect(
      progressEventToEnvelope(
        {
          callId: "read-call",
          effect: "read",
          output: "contents",
          summary: "read src/index.ts",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        correlation,
        metadata,
      ).payload,
    ).toEqual({
      effect: "read",
      kind: "tool_output",
      output: "contents",
      summary: "read src/index.ts",
      title: "Read",
      toolName: "readTool",
    });

    expect(progressEventToEnvelope({ type: "reasoning" }, correlation, metadata).payload).toEqual({
      kind: "reasoning",
    });

    const usage = {
      cachedInputTokens: 1,
      inputTokens: 2,
      outputTokens: 3,
      peakInputTokens: 2,
      totalTokens: 5,
    };
    expect(
      progressEventToEnvelope(
        { model: "gpt-test", type: "usage_updated", usage },
        correlation,
        metadata,
      ).payload,
    ).toEqual({ kind: "usage", model: "gpt-test", usage });
  });

  it("preserves child and tool correlation", () => {
    const envelope = progressEventToEnvelope(
      {
        callId: "child-call",
        input: { path: "src/index.ts" },
        summary: "view src/index.ts",
        title: "Read",
        toolName: "readTool",
        type: "tool_called",
      },
      {
        agentId: "child",
        parentAgentId: "root",
        parentToolCallId: "delegate-call",
        sessionId: "session-1",
        taskId: "task-1",
      },
      metadata,
    );

    expect(envelope).toMatchObject({
      agentId: "child",
      parentAgentId: "root",
      parentToolCallId: "delegate-call",
      payload: { kind: "tool_called", toolName: "readTool" },
      taskId: "task-1",
      toolCallId: "child-call",
    });
    expect(envelopeToProgressEvent(envelope)).toEqual({
      callId: "child-call",
      input: { path: "src/index.ts" },
      summary: "view src/index.ts",
      title: "Read",
      toolName: "readTool",
      type: "tool_called",
    });
  });

  it("correlates legacy subagent lifecycle events to the child", () => {
    const spawned = progressEventToEnvelope(
      {
        agentId: "child",
        agentType: "code",
        profileId: "profile-1",
        taskId: "task-1",
        type: "subagent_spawned",
      },
      {
        agentId: "root",
        parentToolCallId: "delegate-call",
        sessionId: "session-1",
      },
      metadata,
    );

    expect(spawned).toMatchObject({
      agentId: "child",
      parentAgentId: "root",
      parentToolCallId: "delegate-call",
      payload: {
        agentType: "code",
        kind: "agent_spawned",
        profileId: "profile-1",
      },
      taskId: "task-1",
    });
    expect(envelopeToProgressEvent(spawned)).toEqual({
      agentId: "child",
      agentType: "code",
      parentAgentId: "root",
      parentSessionId: "session-1",
      parentToolCallId: "delegate-call",
      profileId: "profile-1",
      taskId: "task-1",
      type: "subagent_spawned",
    });

    const finished = progressEventToEnvelope(
      {
        agentId: "child",
        profileId: "profile-1",
        status: "succeeded",
        taskId: "task-1",
        type: "subagent_result",
      },
      {
        agentId: "root",
        parentToolCallId: "delegate-call",
        sessionId: "session-1",
      },
      metadata,
    );
    expect(finished).toMatchObject({
      agentId: "child",
      parentAgentId: "root",
      parentToolCallId: "delegate-call",
      payload: {
        kind: "agent_finished",
        profileId: "profile-1",
        status: "succeeded",
      },
      taskId: "task-1",
    });
  });

  it("preserves complete subagent identity, output, and failure details", () => {
    const childCorrelation = {
      agentId: "child",
      agentSessionId: "session-1.agent.child",
      parentAgentId: "root",
      parentToolCallId: "delegate-call",
      sessionId: "session-1",
      taskId: "task-1",
    } as const;
    const output = progressEventToEnvelope(
      {
        agentId: "child",
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.child",
        output: "review complete",
        profileId: "reviewer",
        taskId: "task-1",
        type: "subagent_output",
      },
      childCorrelation,
      metadata,
    );
    expect(output).toMatchObject({
      agentSessionId: "session-1.agent.child",
      parentAgentId: "root",
      parentToolCallId: "delegate-call",
      payload: {
        agentName: "Reviewer",
        kind: "agent_output",
        profileId: "reviewer",
        text: "review complete",
      },
    });
    expect(envelopeToProgressEvent(output)).toMatchObject({
      agentName: "Reviewer",
      agentSessionId: "session-1.agent.child",
      output: "review complete",
      type: "subagent_output",
    });

    const failed = progressEventToEnvelope(
      {
        agentId: "child",
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.child",
        error: "review failed",
        profileId: "reviewer",
        status: "failed",
        taskId: "task-1",
        type: "subagent_result",
      },
      childCorrelation,
      metadata,
    );
    expect(envelopeToProgressEvent(failed)).toMatchObject({
      agentName: "Reviewer",
      agentSessionId: "session-1.agent.child",
      error: "review failed",
      status: "failed",
      type: "subagent_result",
    });
  });

  it.each(allProgressEvents.map((event) => [event.type, event] as const))(
    "round-trips the %s variant",
    (_type, event) => {
      const envelope = progressEventToEnvelope(event, correlation, metadata);
      expect(envelopeToProgressEvent(envelope)).toEqual(event);
    },
  );

  it("retains lifecycle values instead of dropping unsupported legacy events", () => {
    const event = {
      checkpointRevision: 4,
      sessionStatus: "needs-review",
      stageId: "stage-2",
      type: "checkpoint_saved",
    } as const;

    const envelope = progressEventToEnvelope(event, correlation, metadata);

    expect(envelope.payload).toEqual({
      kind: "session_lifecycle",
      phase: "checkpoint_saved",
      values: {
        checkpointRevision: 4,
        sessionStatus: "needs-review",
        stageId: "stage-2",
      },
    });
    expect(envelopeToProgressEvent(envelope)).toEqual(event);
  });

  it("omits absent optional properties", () => {
    const envelope = progressEventToEnvelope(
      {
        summary: "run command",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      },
      correlation,
      metadata,
    );

    expect(envelope).not.toHaveProperty("parentAgentId");
    expect(envelope).not.toHaveProperty("parentToolCallId");
    expect(envelope).not.toHaveProperty("taskId");
    expect(envelope).not.toHaveProperty("toolCallId");
    expect(envelope.payload).not.toHaveProperty("effect");
    expect(envelope.payload).not.toHaveProperty("input");
    expect(envelopeToProgressEvent(envelope)).toEqual({
      summary: "run command",
      title: "Bash",
      toolName: "bashTool",
      type: "tool_called",
    });
  });

  it("uses UUID and current ISO time defaults", () => {
    const before = Date.now();
    const envelope = progressEventToEnvelope({ text: "Hello", type: "message_delta" }, correlation);
    const after = Date.now();

    expect(envelope.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(Date.parse(envelope.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(envelope.occurredAt)).toBeLessThanOrEqual(after);
  });

  it("returns undefined for new payloads without a legacy representation", () => {
    expect(
      envelopeToProgressEvent({
        agentId: "root",
        eventId: "event-1",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {
          action: "created",
          checkpointId: "checkpoint-1",
          kind: "checkpoint",
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
    expect(
      envelopeToProgressEvent({
        agentId: "child",
        eventId: "event-spawn",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {
          agentType: "code",
          kind: "agent_spawned",
          profileId: "reviewer",
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
    expect(
      envelopeToProgressEvent({
        agentId: "root",
        eventId: "event-1",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {
          kind: "session_lifecycle",
          phase: "future_phase",
          values: { value: true },
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
    expect(
      envelopeToProgressEvent({
        agentId: "child",
        eventId: "event-2",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {
          kind: "agent_output",
          text: "output without profile",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ).toBeUndefined();
    expect(
      envelopeToProgressEvent({
        agentId: "child",
        eventId: "event-3",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {
          kind: "agent_finished",
          status: "failed",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ).toBeUndefined();
  });
});
