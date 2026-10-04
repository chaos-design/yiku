import { PassThrough } from "node:stream";
import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import { describe, expect, it } from "vitest";
import { NdjsonOutputWriter } from "../../src/output/ndjson-output.js";

describe("NdjsonOutputWriter", () => {
  it("streams stable progress event names and one enriched terminal event", () => {
    const output = createOutput();
    const writer = new NdjsonOutputWriter(output.stream);
    const events = [
      {
        agentName: "Code",
        model: "test-model",
        prompt: "review",
        sessionId: "session-1",
        startedAt: "2026-08-19T00:00:00.000Z",
        type: "session_started",
        workspaceDir: "/workspace",
      },
      { stage: 1, stageId: "stage-1", totalStages: 1, type: "stage_started" },
      { text: "working", type: "message_delta" },
      {
        callId: "call-1",
        summary: "Read file",
        title: "Read",
        toolName: "readTool",
        type: "tool_called",
      },
      {
        callId: "call-1",
        output: "contents",
        summary: "Read file",
        title: "Read",
        toolName: "readTool",
        type: "tool_output",
      },
      {
        questionId: "question-1",
        request: { question: "Continue?" },
        type: "user_question_requested",
      },
      {
        checkpointRevision: 2,
        sessionStatus: "active",
        stageId: "stage-1",
        type: "checkpoint_saved",
      },
      {
        attempts: 1,
        counts: { error: 0, failed: 0, "not-run": 0, passed: 1 },
        decision: "accepted",
        failedChecks: [],
        grade: "A",
        overallScore: 1,
        type: "evaluation_finished",
      },
      {
        durationMs: 10,
        finishedAt: "2026-08-19T00:00:00.010Z",
        output: "done",
        sessionId: "session-1",
        type: "session_finished",
      },
    ] as unknown as readonly AgentProgressEvent[];

    for (const event of events) {
      writer.observe(event);
    }
    writer.writeSuccess({ diagnostics: [], output: "done" });

    const lines = readLines(output.read());
    expect(lines.map((line) => line.type)).toEqual([
      "session.started",
      "stage.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "question.requested",
      "checkpoint.saved",
      "verification.completed",
      "session.completed",
    ]);
    expect(lines.at(-1)).toMatchObject({
      output: "done",
      sessionId: "session-1",
      status: "completed",
    });
  });

  it("keeps every line valid JSON for circular tool output", () => {
    const output = createOutput();
    const writer = new NdjsonOutputWriter(output.stream);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    writer.observe({
      output: circular,
      summary: "Circular",
      title: "Tool",
      toolName: "customTool",
      type: "tool_output",
    });
    writer.writeFailure({
      diagnostics: [],
      error: { code: "CLI_EXECUTION_FAILED", message: "failed" },
      status: "failed",
    });

    const lines = readLines(output.read());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: { output: { self: "[Circular]" } },
      type: "tool.completed",
    });
    expect(lines[1]).toMatchObject({
      error: { code: "CLI_EXECUTION_FAILED" },
      type: "session.failed",
    });
  });
});

function readLines(value: string): readonly Record<string, unknown>[] {
  return value
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createOutput(): {
  readonly read: () => string;
  readonly stream: NodeJS.WriteStream;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as NodeJS.WriteStream;
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  return {
    read: () => chunks.join(""),
    stream,
  };
}
