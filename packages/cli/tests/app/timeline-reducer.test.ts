import type { AgentMessageEnvelope, AgentMessagePayload } from "@yiku/agent-orchestrator";
import { describe, expect, it } from "vitest";
import {
  createRuntimeTimelineState,
  reduceRuntimeTimeline,
} from "../../src/app/timeline-reducer.js";
import type { TimelineHeaderItem, TimelineToolItem } from "../../src/app/types.js";

describe("runtime timeline reducer", () => {
  it("aggregates root assistant deltas without changing existing timeline item types", () => {
    const header = {
      id: "header:0",
      kind: "header",
      model: "gpt-test",
      workspaceDir: "/workspace",
    } satisfies TimelineHeaderItem;
    const initial = createRuntimeTimelineState("root", [header]);
    const first = reduceRuntimeTimeline(
      initial,
      envelope("root", { kind: "assistant_delta", text: "Hello" }),
    );
    const second = reduceRuntimeTimeline(
      first,
      envelope("root", { kind: "assistant_delta", text: " world" }),
    );
    const withTool = reduceRuntimeTimeline(
      second,
      envelope(
        "root",
        {
          input: { path: "README.md" },
          kind: "tool_called",
          summary: "read README.md",
          title: "Read",
          toolName: "readFileTool",
        },
        { toolCallId: "read-root" },
      ),
    );

    expect(initial.root).toEqual({
      agentId: "root",
      items: [header],
      status: "running",
    });
    expect(second.root.activeAssistant?.text).toBe("Hello world");
    expect(second.root.items).toEqual([header]);
    expect(withTool.root.items).toEqual([
      header,
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({ role: "assistant", text: "Hello world" }),
      }),
    ]);
    expect(withTool.root.activeTool).toMatchObject({
      callId: "read-root",
      kind: "tool",
      toolName: "readFileTool",
    });
    expect(withTool.agents).toBe(initial.agents);
  });

  it("matches parallel tool output by call ID and preserves an active tool for unknown output", () => {
    let state = createRuntimeTimelineState("root");
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        { agentType: "code", kind: "agent_spawned", profileId: "worker" },
        {
          parentAgentId: "root",
          parentToolCallId: "delegate-a",
          taskId: "task-a",
        },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        {
          input: { path: "a.ts" },
          kind: "tool_called",
          summary: "read a.ts",
          title: "Read",
          toolName: "readFileTool",
        },
        { toolCallId: "read-a" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        {
          input: { path: "b.ts" },
          kind: "tool_called",
          summary: "write b.ts",
          title: "Write",
          toolName: "writeFileTool",
        },
        { toolCallId: "write-b" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        {
          kind: "tool_output",
          output: "contents a",
          summary: "read a.ts",
          title: "Read",
          toolName: "readFileTool",
        },
        { toolCallId: "read-a" },
      ),
    );

    const afterRead = state.agents.get("child-a");
    expect(afterRead?.items).toEqual([
      expect.objectContaining({
        callId: "read-a",
        result: { text: "contents a" },
      }),
    ]);
    expect(afterRead?.activeTool?.callId).toBe("write-b");

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        {
          kind: "tool_output",
          output: "orphaned",
          summary: "unknown output",
          title: "Unknown",
          toolName: "unknownTool",
        },
        { toolCallId: "unknown-call" },
      ),
    );

    const afterUnknown = state.agents.get("child-a");
    expect(afterUnknown?.activeTool).toBe(afterRead?.activeTool);
    expect(afterUnknown?.items.at(-1)).toMatchObject({
      callId: "unknown-call",
      kind: "tool",
      result: { text: "orphaned" },
      toolName: "unknownTool",
    });

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        {
          kind: "tool_output",
          output: "wrote b",
          summary: "write b.ts",
          title: "Write",
          toolName: "writeFileTool",
        },
        { toolCallId: "write-b" },
      ),
    );

    const finishedTools = state.agents
      .get("child-a")
      ?.items.filter((item): item is TimelineToolItem => item.kind === "tool");
    expect(finishedTools?.map((item) => [item.callId, item.result?.text])).toEqual([
      ["read-a", "contents a"],
      ["unknown-call", "orphaned"],
      ["write-b", "wrote b"],
    ]);
    expect(state.agents.get("child-a")?.activeTool).toBeUndefined();
  });

  it("uses the tool name only as a legacy fallback when the output has no call ID", () => {
    let state = createRuntimeTimelineState("root");
    state = reduceRuntimeTimeline(
      state,
      envelope("root", {
        kind: "tool_called",
        summary: "legacy call",
        title: "Legacy",
        toolName: "legacyTool",
      }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "root",
        {
          kind: "tool_output",
          output: "modern orphan",
          summary: "mismatched output",
          title: "Legacy",
          toolName: "legacyTool",
        },
        { toolCallId: "unexpected-call" },
      ),
    );

    expect(state.root.activeTool?.toolName).toBe("legacyTool");
    expect(state.root.items).toEqual([
      expect.objectContaining({
        callId: "unexpected-call",
        result: { text: "modern orphan" },
      }),
    ]);

    state = reduceRuntimeTimeline(
      state,
      envelope("root", {
        kind: "tool_output",
        output: "legacy result",
        summary: "legacy output",
        title: "Legacy",
        toolName: "legacyTool",
      }),
    );

    expect(state.root.activeTool).toBeUndefined();
    expect(state.root.items).toEqual([
      expect.objectContaining({
        callId: "unexpected-call",
        result: { text: "modern orphan" },
      }),
      expect.objectContaining({
        result: { text: "legacy result" },
        toolName: "legacyTool",
      }),
    ]);
  });

  it("keeps interleaved children isolated and completes both finish event variants", () => {
    let state = createRuntimeTimelineState("root");
    for (const agentId of ["child-a", "child-b"]) {
      state = reduceRuntimeTimeline(
        state,
        envelope(
          agentId,
          { agentType: "code", kind: "agent_spawned", profileId: agentId },
          {
            occurredAt: `2026-08-10T00:00:0${agentId === "child-a" ? "1" : "2"}.000Z`,
            parentAgentId: "root",
            parentToolCallId: `delegate-${agentId}`,
            taskId: `task-${agentId}`,
          },
        ),
      );
    }

    state = reduceRuntimeTimeline(
      state,
      envelope("child-a", { kind: "assistant_delta", text: "A1" }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child-b", { kind: "assistant_delta", text: "B1" }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child-a", { kind: "assistant_delta", text: " A2" }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-b",
        {
          kind: "tool_called",
          summary: "inspect",
          title: "Inspect",
          toolName: "inspectTool",
        },
        { toolCallId: "inspect-b" },
      ),
    );
    const childBBeforeFinish = state.agents.get("child-b");

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-a",
        { error: "provider disconnected", kind: "agent_finished", status: "failed" },
        { occurredAt: "2026-08-10T00:01:00.000Z" },
      ),
    );

    expect(state.agents.get("child-a")).toMatchObject({
      activeAssistant: undefined,
      agentType: "code",
      completedAt: "2026-08-10T00:01:00.000Z",
      error: "provider disconnected",
      parentToolCallId: "delegate-child-a",
      startedAt: "2026-08-10T00:00:01.000Z",
      status: "failed",
    });
    expect(state.agents.get("child-a")?.items).toEqual([
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({ text: "A1 A2" }),
      }),
    ]);
    expect(state.agents.get("child-b")).toBe(childBBeforeFinish);
    expect(state.agents.get("child-b")?.activeAssistant).toBeUndefined();
    expect(state.agents.get("child-b")?.activeTool?.callId).toBe("inspect-b");

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child-b",
        {
          kind: "session_lifecycle",
          phase: "subagent_result",
          values: { status: "failed" },
        },
        { occurredAt: "2026-08-10T00:02:00.000Z" },
      ),
    );

    expect(state.agents.get("child-b")).toMatchObject({
      activeAssistant: undefined,
      agentType: "code",
      completedAt: "2026-08-10T00:02:00.000Z",
      parentToolCallId: "delegate-child-b",
      startedAt: "2026-08-10T00:00:02.000Z",
      status: "failed",
    });
    expect(state.agents.get("child-b")?.items).toEqual([
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({ text: "B1" }),
      }),
      expect.objectContaining({
        callId: "inspect-b",
        kind: "tool",
        toolName: "inspectTool",
      }),
    ]);
  });

  it("stores explicit Agent identity and deduplicates the final Agent output", () => {
    let state = createRuntimeTimelineState("root");
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          agentName: "Reviewer",
          agentType: "code",
          kind: "agent_spawned",
          profileId: "reviewer",
          prompt: "Review the repository",
        },
        {
          agentSessionId: "session.agent.child",
          parentAgentId: "root",
          parentToolCallId: "delegate-1",
          taskId: "task-1",
        },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child", { kind: "assistant_delta", text: "review complete" }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child", {
        agentName: "Reviewer",
        kind: "agent_output",
        profileId: "reviewer",
        text: "review complete",
      }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child", {
        agentName: "Reviewer",
        kind: "agent_finished",
        profileId: "reviewer",
        status: "succeeded",
      }),
    );

    expect(state.agents.get("child")).toMatchObject({
      agentName: "Reviewer",
      agentSessionId: "session.agent.child",
      agentType: "code",
      profileId: "reviewer",
      prompt: "Review the repository",
      status: "succeeded",
    });
    expect(state.agents.get("child")?.items).toEqual([
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({ text: "review complete" }),
      }),
    ]);
  });

  it("covers no-op envelopes, blank deltas, and completed stored tool correlation", () => {
    const initial = createRuntimeTimelineState("root");
    for (const payload of [
      { action: "created", checkpointId: "checkpoint", kind: "checkpoint" as const },
      { kind: "reasoning" as const },
      {
        kind: "usage" as const,
        model: "model",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          peakInputTokens: 0,
          totalTokens: 0,
        },
      },
      {
        from: "sandbox",
        kind: "runtime_boundary_changed" as const,
        reason: "fallback",
        to: "host-policy",
      },
      {
        action: "allow",
        eventName: "BeforeToolCall",
        kind: "hook_decision" as const,
        reasons: [],
      },
    ]) {
      expect(reduceRuntimeTimeline(initial, envelope("root", payload))).toBe(initial);
    }
    expect(
      reduceRuntimeTimeline(
        initial,
        envelope("root", {
          kind: "session_lifecycle",
          phase: "session_started",
        }),
      ),
    ).toBe(initial);

    let state = reduceRuntimeTimeline(
      initial,
      envelope("child", { kind: "assistant_delta", text: " " }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child", { kind: "agent_finished", status: "cancelled" }),
    );
    expect(state.agents.get("child")).toMatchObject({
      activeAssistant: undefined,
      items: [],
      status: "cancelled",
    });

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          kind: "tool_called",
          summary: "read",
          title: "Read",
          toolName: "readTool",
        },
        { parentToolCallId: "delegate", toolCallId: "stored-call" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          kind: "tool_called",
          summary: "next",
          title: "Next",
          toolName: "nextTool",
        },
        { parentToolCallId: "delegate", toolCallId: "next-call" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          kind: "tool_output",
          output: "stored output",
          summary: "read",
          title: "Read",
          toolName: "readTool",
        },
        { toolCallId: "stored-call" },
      ),
    );
    expect(state.agents.get("child")?.items[0]).toMatchObject({
      callId: "stored-call",
      output: "stored output",
      result: { text: "stored output" },
    });

    const unchanged = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          kind: "tool_output",
          output: "repeat",
          summary: "repeat",
          title: "Read",
          toolName: "readTool",
        },
        {},
      ),
    );
    expect(unchanged.agents.get("child")?.activeTool?.callId).toBe("next-call");
    const withAssistantAfterTools = reduceRuntimeTimeline(
      unchanged,
      envelope("child", { kind: "assistant_delta", text: "after tools" }),
    );
    expect(withAssistantAfterTools.agents.get("child")?.activeAssistant?.id).toBe(1);
  });

  it("handles optional tool fields, legacy status validation, and existing message IDs", () => {
    const messageItem = {
      id: "message:7",
      kind: "message" as const,
      message: { id: 7, role: "assistant" as const, text: "existing" },
    };
    let state = createRuntimeTimelineState("root", [messageItem]);
    state = reduceRuntimeTimeline(
      state,
      envelope("root", { kind: "assistant_delta", text: "next" }),
    );
    expect(state.root.activeAssistant?.id).toBe(8);

    state = reduceRuntimeTimeline(
      state,
      envelope("child", {
        effect: "write",
        kind: "tool_called",
        summary: "edit",
        title: "Edit",
        toolName: "editTool",
      }),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope("child", {
        effect: "write",
        kind: "tool_output",
        summary: "edited",
        title: "Edit",
        toolName: "editTool",
      }),
    );
    expect(state.agents.get("child")?.items[0]).toMatchObject({
      result: { text: "Edit finished" },
    });
    expect(state.agents.get("child")?.items[0]).not.toHaveProperty("output");

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "child",
        {
          kind: "tool_output",
          summary: "orphan",
          title: "Orphan",
          toolName: "orphanTool",
        },
        { toolCallId: "orphan" },
      ),
    );
    expect(state.agents.get("child")?.items.at(-1)).toMatchObject({
      callId: "orphan",
      result: { text: "Orphan finished" },
    });

    state = reduceRuntimeTimeline(
      state,
      envelope(
        "stored-child",
        {
          kind: "tool_called",
          summary: "first",
          title: "First",
          toolName: "firstTool",
        },
        { toolCallId: "first" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "stored-child",
        {
          kind: "tool_called",
          summary: "second",
          title: "Second",
          toolName: "secondTool",
        },
        { toolCallId: "second" },
      ),
    );
    state = reduceRuntimeTimeline(
      state,
      envelope(
        "stored-child",
        {
          kind: "tool_output",
          summary: "first done",
          title: "First",
          toolName: "firstTool",
        },
        { toolCallId: "first" },
      ),
    );
    expect(state.agents.get("stored-child")?.items[0]).toMatchObject({
      result: { text: "First finished" },
    });
    expect(state.agents.get("stored-child")?.items[0]).not.toHaveProperty("output");

    for (const values of [null, [], { status: "unknown" }]) {
      const before = state;
      state = reduceRuntimeTimeline(
        state,
        envelope("child", {
          kind: "session_lifecycle",
          phase: "subagent_result",
          values,
        }),
      );
      expect(state).toBe(before);
    }
  });
});

interface EnvelopeOptions {
  readonly agentSessionId?: string;
  readonly occurredAt?: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly taskId?: string;
  readonly toolCallId?: string;
}

let eventSequence = 0;

function envelope<TPayload extends AgentMessagePayload>(
  agentId: string,
  payload: TPayload,
  options: EnvelopeOptions = {},
): AgentMessageEnvelope<TPayload> {
  eventSequence += 1;

  return {
    agentId,
    ...(options.agentSessionId !== undefined ? { agentSessionId: options.agentSessionId } : {}),
    eventId: `event-${eventSequence}`,
    occurredAt: options.occurredAt ?? "2026-08-10T00:00:00.000Z",
    ...(options.parentAgentId !== undefined ? { parentAgentId: options.parentAgentId } : {}),
    ...(options.parentToolCallId !== undefined
      ? { parentToolCallId: options.parentToolCallId }
      : {}),
    payload,
    sessionId: "session-1",
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
  };
}
