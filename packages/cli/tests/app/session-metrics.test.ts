import type { AgentProgressEvent, AgentUsage } from "@yiku/agent-orchestrator";
import { describe, expect, it } from "vitest";
import {
  calculateContextUsage,
  formatContextUsage,
  formatContextUsageDetails,
  formatContextWindow,
  formatDuration,
  formatPromptContextUsage,
  formatTokenCount,
  SessionMetrics,
} from "../../src/app/session-metrics.js";

type ToolCallEvent = Extract<AgentProgressEvent, { readonly type: "tool_called" }>;
type ToolOutputEvent = Extract<AgentProgressEvent, { readonly type: "tool_output" }>;

const baseUsage: AgentUsage = {
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  peakInputTokens: 0,
  totalTokens: 0,
};

describe("SessionMetrics", () => {
  it("aggregates usage snapshots by model without double counting", () => {
    const metrics = new SessionMetrics({
      model: "fallback",
      sessionId: "session-1",
      startedAtMs: 0,
    });

    metrics.updateContext("model-a", 128_000);
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      cachedInputTokens: 400,
      inputTokens: 1_000,
      outputTokens: 100,
      peakInputTokens: 800,
      totalTokens: 1_100,
    });
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      cachedInputTokens: 600,
      inputTokens: 1_500,
      outputTokens: 150,
      peakInputTokens: 1_200,
      totalTokens: 1_650,
    });
    metrics.recordUsage(2, "model-b", {
      ...baseUsage,
      cachedInputTokens: 200,
      inputTokens: 700,
      outputTokens: 70,
      peakInputTokens: 650,
      totalTokens: 770,
    });

    expect(metrics.snapshot().contextTokens).toBe(1_850);
    expect(metrics.buildSummary(5_000)).toMatchObject({
      contextWindow: 128_000,
      model: "model-a",
      peakInputTokens: 1_850,
      sessionId: "session-1",
      usageByModel: [
        {
          cachedInputTokens: 600,
          inputTokens: 1_500,
          model: "model-a",
          outputTokens: 150,
        },
        {
          cachedInputTokens: 200,
          inputTokens: 700,
          model: "model-b",
          outputTokens: 70,
        },
      ],
      wallDurationMs: 5_000,
    });
  });

  it("subtracts tool duration from Agent run duration", () => {
    const metrics = createMetrics();

    metrics.startRun(1, 1_000);
    metrics.recordToolCall(toolCall("bashTool", "Bash", { command: "sleep 1" }), 2_000);
    metrics.recordToolOutput(toolOutput("bashTool", "Bash", "done"), 3_500);
    metrics.finishRun(1, 6_000);

    expect(metrics.buildSummary(7_000)).toMatchObject({
      apiDurationMs: 3_500,
      toolCalls: [
        {
          calls: 1,
          durationMs: 1_500,
          errors: 0,
          name: "Bash",
        },
      ],
      wallDurationMs: 7_000,
    });
  });

  it("accumulates live Context usage by run until an explicit reset", () => {
    const metrics = createMetrics();
    metrics.updateContext("model-a", 10_000);
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      inputTokens: 1_000,
      peakInputTokens: 800,
      totalTokens: 1_000,
    });
    metrics.recordUsage(2, "model-a", {
      ...baseUsage,
      inputTokens: 200,
      peakInputTokens: 200,
      totalTokens: 200,
    });
    metrics.recordToolCall(toolCall("bashTool", "Bash", { command: "sleep 1" }), 1_000);

    expect(metrics.snapshot(2_500)).toMatchObject({
      contextTokens: 1_000,
      contextWindow: 10_000,
      model: "model-a",
      peakInputTokens: 1_000,
      toolCalls: [{ calls: 1, durationMs: 1_500, name: "Bash" }],
    });
    metrics.recordRuntimeEvent({
      afterEntries: 1,
      beforeEntries: 10,
      type: "context_compacted",
    });
    expect(metrics.snapshot(2_500)).toMatchObject({
      contextTokens: 0,
      peakInputTokens: 1_000,
    });
    metrics.recordUsage(3, "model-a", {
      ...baseUsage,
      inputTokens: 150,
      peakInputTokens: 150,
      totalTokens: 150,
    });
    expect(metrics.snapshot(2_500)).toMatchObject({
      contextTokens: 150,
      peakInputTokens: 1_000,
    });
    metrics.resetContext();
    expect(metrics.snapshot(2_500).contextTokens).toBe(0);

    metrics.recordToolOutput(toolOutput("bashTool", "Bash", "done"), 3_000);
    expect(metrics.buildSummary(4_000).toolCalls).toEqual([
      { calls: 1, durationMs: 2_000, errors: 0, name: "Bash" },
    ]);
    expect(formatContextUsage(800, 10_000)).toBe("8% used (800 / 10K)");
    expect(formatPromptContextUsage(800, 10_000)).toBe("800/10K tokens (8%)");
    expect(formatPromptContextUsage(800)).toBe("unavailable");
    expect(formatContextUsageDetails(2_000, 10_000)).toContain("2K / 10K tokens (20% used)");
    expect(formatContextUsageDetails(2_000, 10_000).match(/●/gu)).toHaveLength(21);
    expect(formatContextUsageDetails(1, 0)).toContain("Context limit unavailable");
  });

  it("calibrates Context categories and reserves the configured compaction buffer", () => {
    const metrics = createMetrics();
    metrics.updateContext(
      "model-a",
      1_000,
      {
        procedureMemoryTokens: 20,
        scenarioMemoryTokens: 10,
        semanticMemoryTokens: 30,
        skillTokens: 40,
        systemPromptTokens: 100,
        systemToolTokens: 50,
        workingMemoryTokens: 30,
      },
      0.8,
      "inferred",
    );
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      inputTokens: 400,
      peakInputTokens: 400,
      totalTokens: 400,
    });

    const usage = calculateContextUsage(metrics.snapshot());
    expect(usage).toMatchObject({
      autocompactBufferTokens: 200,
      contextWindow: 1_000,
      contextWindowSource: "inferred",
      freeTokens: 400,
      model: "model-a",
      usedTokens: 400,
    });
    expect(
      Object.fromEntries(usage.categories.map((category) => [category.key, category.tokens])),
    ).toEqual({
      messages: 120,
      "procedure-memory": 20,
      "scenario-memory": 10,
      "semantic-memory": 30,
      skills: 40,
      "system-prompt": 100,
      "system-tools": 50,
      "working-memory": 30,
    });
  });

  it("scales oversized static estimates and handles missing Context metadata", () => {
    const metrics = createMetrics();
    metrics.updateContext("model-a", 100, {
      procedureMemoryTokens: 20,
      scenarioMemoryTokens: 20,
      semanticMemoryTokens: 20,
      skillTokens: 20,
      systemPromptTokens: 20,
      systemToolTokens: 20,
      workingMemoryTokens: 20,
    });
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      inputTokens: 50,
      peakInputTokens: 50,
      totalTokens: 50,
    });

    const scaled = calculateContextUsage(metrics.snapshot());
    expect(scaled.categories.reduce((total, category) => total + category.tokens, 0)).toBe(50);
    expect(scaled.categories.at(-1)).toMatchObject({
      key: "messages",
      tokens: 0,
    });
    expect(scaled.autocompactBufferTokens).toBe(8);

    const unknown = calculateContextUsage({
      ...metrics.snapshot(),
      contextTokens: 10,
      contextWindow: undefined,
      contextComposition: undefined,
    });
    expect(unknown).toMatchObject({
      autocompactBufferTokens: 0,
      model: "model-a",
      usedTokens: 10,
    });
    expect(unknown.categories.at(-1)).toMatchObject({
      key: "messages",
      tokens: 10,
    });

    const zero = calculateContextUsage({
      ...metrics.snapshot(),
      contextTokens: 0,
      contextWindow: 0,
    });
    expect(zero.categories.every((category) => category.tokens === 0)).toBe(true);
    expect(zero.contextWindow).toBeUndefined();
  });

  it("keeps finalized metrics immutable across late events", () => {
    const metrics = createMetrics();
    metrics.recordRuntimeEvent({
      outcome: "paused",
      stageId: "stage-1",
      type: "stage_finished",
    });
    metrics.recordToolCall(toolCall("textEditorTool", "Edit", null), 0);
    metrics.recordToolOutput(toolOutput("textEditorTool", "Edit", "done"), 1);
    const summary = metrics.buildSummary(100);

    metrics.updateContext("late", 1_000);
    metrics.finishRun(1, 200);
    metrics.recordUsage(1, "late", {
      ...baseUsage,
      inputTokens: 1,
      peakInputTokens: 1,
      totalTokens: 1,
    });
    metrics.resetContext();
    metrics.recordToolCall(toolCall("bashTool", "Bash", null), 200);
    metrics.recordToolOutput(toolOutput("bashTool", "Bash", "done"), 300);
    metrics.recordRuntimeEvent({
      outcome: "paused",
      stageId: "late",
      type: "stage_finished",
    });

    expect(metrics.buildSummary(400)).toBe(summary);
    expect(metrics.snapshot(400).contextTokens).toBe(0);
  });

  it("tracks tool order, errors, and display names", () => {
    const metrics = createMetrics();

    metrics.recordToolCall(
      toolCall("textEditorTool", "Edit", { command: "view", path: "README.md" }),
      100,
    );
    metrics.recordToolOutput(toolOutput("textEditorTool", "Edit", "content"), 300);
    metrics.recordToolCall(toolCall("bashTool", "Bash", { command: "false" }), 400);
    metrics.recordToolOutput(toolOutput("bashTool", "Bash", "Error: failed"), 900);
    metrics.recordToolCall(toolCall("customTool", "Custom", {}), 1_000);

    expect(metrics.buildSummary(1_250).toolCalls).toEqual([
      {
        calls: 1,
        durationMs: 200,
        errors: 0,
        name: "Read",
      },
      {
        calls: 1,
        durationMs: 500,
        errors: 1,
        name: "Bash",
      },
      {
        calls: 1,
        durationMs: 250,
        errors: 0,
        name: "Custom",
      },
    ]);
  });

  it("correlates concurrent tools by callId", () => {
    const metrics = createMetrics();

    metrics.recordToolCall(toolCall("grepTool", "Grep", {}, "call-1"), 100);
    metrics.recordToolCall(toolCall("grepTool", "Grep", {}, "call-2"), 110);
    metrics.recordToolOutput(toolOutput("grepTool", "Grep", "second", "call-2"), 130);
    metrics.recordToolOutput(toolOutput("grepTool", "Grep", "first", "call-1"), 150);

    expect(metrics.buildSummary(200).toolCalls).toEqual([
      {
        calls: 2,
        durationMs: 70,
        errors: 0,
        name: "Grep",
      },
    ]);
  });

  it("counts successful text editor changes only", () => {
    const metrics = createMetrics();

    recordEdit(metrics, { command: "create", file_text: "one\ntwo" }, "created", 0);
    recordEdit(metrics, { command: "insert", new_str: "three" }, "inserted", 10);
    recordEdit(
      metrics,
      { command: "str_replace", new_str: "next\nvalue", old_str: "old\nvalue\nhere" },
      "replaced",
      20,
    );
    recordEdit(
      metrics,
      { command: "str_replace", new_str: "ignored", old_str: "ignored" },
      "Error: failed",
      30,
    );
    recordEdit(metrics, { command: "create", file_text: "" }, "created", 40);
    recordEdit(metrics, { command: "view" }, "content", 50);

    expect(metrics.buildSummary(100)).toMatchObject({
      addedLines: 5,
      removedLines: 3,
    });
  });

  it("summarizes stages, checkpoints, tasks, and pause reasons", () => {
    const metrics = createMetrics();

    metrics.recordRuntimeEvent({
      checkpointRevision: 2,
      sessionStatus: "active",
      stageId: "stage-1",
      type: "checkpoint_saved",
    });
    metrics.recordRuntimeEvent({
      checkpointRevision: 3,
      sessionStatus: "paused",
      stageId: "stage-1",
      type: "checkpoint_saved",
    });
    metrics.recordRuntimeEvent({
      stage: 1,
      stageId: "stage-1",
      totalStages: 1,
      type: "stage_started",
    });
    metrics.recordRuntimeEvent({
      outcome: "paused",
      reason: "needs-review",
      stageId: "stage-1",
      type: "stage_finished",
    });
    metrics.recordRuntimeEvent({
      blocked: 1,
      completed: 2,
      inProgress: 0,
      pending: 3,
      type: "task_snapshot",
    });

    expect(metrics.buildSummary(100)).toMatchObject({
      checkpointCount: 2,
      pauseReason: "needs-review",
      stageCount: 1,
      tasks: {
        blocked: 1,
        completed: 2,
        inProgress: 0,
        pending: 3,
      },
    });
  });

  it("freezes the first built summary", () => {
    const metrics = createMetrics();
    const summary = metrics.buildSummary(1_000);

    metrics.recordUsage(1, "late-model", {
      ...baseUsage,
      inputTokens: 100,
      peakInputTokens: 100,
      totalTokens: 100,
    });
    metrics.startRun(2, 1_000);

    expect(metrics.buildSummary(2_000)).toBe(summary);
    expect(summary.usageByModel).toEqual([]);
  });
});

describe("session summary formatting", () => {
  it("formats token counts with compact decimal suffixes", () => {
    expect(formatTokenCount(842)).toBe("842");
    expect(formatTokenCount(4_000)).toBe("4K");
    expect(formatTokenCount(77_800)).toBe("77.8K");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("formats compact durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(33_000)).toBe("33s");
    expect(formatDuration(115_000)).toBe("1m55s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_225_000)).toBe("1h27m5s");
  });

  it("formats known and unknown context windows", () => {
    const metrics = createMetrics();
    metrics.updateContext("model-a", 936_000);
    metrics.recordUsage(1, "model-a", {
      ...baseUsage,
      inputTokens: 77_800,
      peakInputTokens: 77_800,
      totalTokens: 77_800,
    });

    expect(formatContextWindow(metrics.buildSummary(0))).toBe("8.3% used (77.8K / 936K)");
    expect(
      formatContextWindow(
        new SessionMetrics({
          model: "model-b",
          sessionId: "session-2",
          startedAtMs: 0,
        }).buildSummary(0),
      ),
    ).toBe("0 used (limit unknown)");
  });
});

function createMetrics(): SessionMetrics {
  return new SessionMetrics({
    model: "model",
    sessionId: "session",
    startedAtMs: 0,
  });
}

function toolCall(
  toolName: string,
  title: string,
  input: unknown,
  callId = toolName,
): ToolCallEvent {
  return {
    callId,
    input,
    summary: "call",
    title,
    toolName,
    type: "tool_called",
  };
}

function toolOutput(
  toolName: string,
  title: string,
  output: unknown,
  callId = toolName,
): ToolOutputEvent {
  return {
    callId,
    output,
    summary: "output",
    title,
    toolName,
    type: "tool_output",
  };
}

function recordEdit(
  metrics: SessionMetrics,
  input: unknown,
  output: string,
  startedAtMs: number,
): void {
  metrics.recordToolCall(toolCall("textEditorTool", "Edit", input), startedAtMs);
  metrics.recordToolOutput(toolOutput("textEditorTool", "Edit", output), startedAtMs + 1);
}
