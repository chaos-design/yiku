import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import { Trace, type TraceEntry } from "../src/trace.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("Trace", () => {
  it("writes ordered JSONL entries with event results", () => {
    const traceDir = createTempDir();
    const traceFilePath = join(traceDir, "sessions", "trace.jsonl");
    const trace = new Trace(traceFilePath);
    const events: readonly AgentProgressEvent[] = [
      {
        agentName: "Code Agent",
        model: "gpt-test",
        prompt: "review this",
        sessionId: "session-1",
        startedAt: "2026-07-30T00:00:00.000Z",
        type: "session_started",
        workspaceDir: "/workspace",
      },
      {
        agentName: "Code Agent",
        type: "agent_updated",
      },
      {
        text: "hello",
        type: "message_delta",
      },
      {
        type: "reasoning",
      },
      {
        summary: "run pnpm test",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      },
      {
        output: "passed",
        summary: "finished passed",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_output",
      },
      {
        summary: "finished",
        title: "Tool",
        toolName: "unknown",
        type: "tool_output",
      },
      {
        model: "gpt-test",
        type: "usage_updated",
        usage: {
          cachedInputTokens: 400,
          inputTokens: 1_000,
          outputTokens: 100,
          peakInputTokens: 800,
          totalTokens: 1_100,
        },
      },
      {
        durationMs: 10,
        finishedAt: "2026-07-30T00:00:01.000Z",
        output: "done",
        sessionId: "session-1",
        type: "session_finished",
      },
      {
        durationMs: 10,
        error: "failed",
        finishedAt: "2026-07-30T00:00:01.000Z",
        sessionId: "session-1",
        type: "session_failed",
      },
    ];

    for (const event of events) {
      trace.record(event);
    }

    const entries = readTraceEntries(traceFilePath);

    expect(entries.map((entry) => entry.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(entries.map((entry) => entry.result)).toEqual([
      "review this",
      "Code Agent",
      "hello",
      "reasoning",
      "run pnpm test",
      "passed",
      "finished",
      {
        cachedInputTokens: 400,
        inputTokens: 1_000,
        outputTokens: 100,
        peakInputTokens: 800,
        totalTokens: 1_100,
      },
      "done",
      "failed",
    ]);
    expect(entries[0]?.event.type).toBe("session_started");
  });

  it("continues step numbers when a session trace is reopened", () => {
    const traceFilePath = join(createTempDir(), "session.jsonl");
    const event: AgentProgressEvent = {
      type: "reasoning",
    };

    new Trace(traceFilePath).record(event);
    new Trace(traceFilePath).record(event);

    expect(readTraceEntries(traceFilePath).map((entry) => entry.step)).toEqual([1, 2]);
  });

  it("records long-running lifecycle event results", () => {
    const traceFilePath = join(createTempDir(), "lifecycle.jsonl");
    const trace = new Trace(traceFilePath);
    const events: readonly AgentProgressEvent[] = [
      {
        checkpointRevision: 2,
        sessionStatus: "active",
        stageId: "stage-1",
        type: "checkpoint_saved",
      },
      {
        afterEntries: 2,
        beforeEntries: 20,
        type: "context_compacted",
      },
      {
        inFlightOperations: 1,
        sessionId: "session-1",
        type: "session_resumed",
      },
      {
        stage: 1,
        stageId: "stage-1",
        totalStages: 1,
        type: "stage_started",
      },
      {
        outcome: "paused",
        stageId: "stage-1",
        type: "stage_finished",
      },
      {
        agentId: "agent-1",
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.agent-1",
        agentKey: "reviewer",
        agentType: "code",
        parentAgentId: "root",
        parentSessionId: "session-1",
        profileId: "reviewer",
        prompt: "Review the code",
        taskId: "task-1",
        type: "subagent_spawned",
      },
      {
        agentId: "agent-1",
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.agent-1",
        output: "review complete",
        profileId: "reviewer",
        taskId: "task-1",
        type: "subagent_output",
      },
      {
        agentId: "agent-1",
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.agent-1",
        profileId: "reviewer",
        status: "succeeded",
        taskId: "task-1",
        type: "subagent_result",
      },
      {
        blocked: 0,
        completed: 3,
        inProgress: 0,
        pending: 0,
        type: "task_snapshot",
      },
    ];

    for (const event of events) {
      trace.record(event);
    }
    expect(readTraceEntries(traceFilePath).map((entry) => entry.result)).toEqual([
      2,
      2,
      "session-1",
      "stage-1",
      "paused",
      {
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.agent-1",
        taskId: "task-1",
      },
      "review complete",
      {
        agentName: "Reviewer",
        agentSessionId: "session-1.agent.agent-1",
        status: "succeeded",
        taskId: "task-1",
      },
      3,
    ]);
  });
});

function readTraceEntries(traceFilePath: string): readonly TraceEntry[] {
  return readFileSync(traceFilePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEntry);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yiku-trace-"));
  tempDirs.push(dir);

  return dir;
}
