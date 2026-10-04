import { PassThrough } from "node:stream";
import type { EvaluationOutcome } from "@yiku/agent-orchestrator";
import { describe, expect, it } from "vitest";
import { JsonOutputWriter } from "../../src/output/json-output.js";

describe("JsonOutputWriter", () => {
  it("collects Session identity, cumulative usage, and verification", () => {
    const output = createOutput();
    const writer = new JsonOutputWriter(output.stream);

    writer.observe({
      agentName: "Code",
      model: "test-model",
      prompt: "review",
      sessionId: "session-1",
      startedAt: "2026-08-19T00:00:00.000Z",
      type: "session_started",
      workspaceDir: "/workspace",
    });
    writer.observe({
      model: "test-model",
      type: "usage_updated",
      usage: {
        cachedInputTokens: 2,
        inputTokens: 10,
        outputTokens: 4,
        peakInputTokens: 8,
        totalTokens: 14,
      },
    });
    writer.observe({
      model: "test-model",
      type: "usage_updated",
      usage: {
        cachedInputTokens: 3,
        inputTokens: 7,
        outputTokens: 2,
        peakInputTokens: 9,
        totalTokens: 9,
      },
    });
    writer.observe({
      attempts: 1,
      counts: { error: 0, failed: 0, "not-run": 0, passed: 2 },
      decision: "accepted",
      failedChecks: [],
      grade: "A",
      overallScore: 1,
      type: "evaluation_finished",
    });

    writer.writeSuccess({
      diagnostics: [],
      evaluation: evaluation("accepted"),
      output: "done",
    });

    expect(JSON.parse(output.read())).toMatchObject({
      output: "done",
      sessionId: "session-1",
      status: "completed",
      usage: {
        cachedInputTokens: 5,
        inputTokens: 17,
        outputTokens: 6,
        peakInputTokens: 9,
        totalTokens: 23,
      },
      verification: {
        decision: "accepted",
        grade: "A",
        overallScore: 1,
      },
    });
  });

  it("normalizes rejected evaluations to the stable failed status", () => {
    const output = createOutput();
    const writer = new JsonOutputWriter(output.stream);

    writer.writeSuccess({
      diagnostics: [],
      evaluation: evaluation("rejected"),
      output: "invalid",
    });

    expect(JSON.parse(output.read())).toMatchObject({
      evaluation: { decision: { action: "rejected" } },
      output: "invalid",
      status: "failed",
    });
  });
});

function evaluation(action: "accepted" | "rejected"): EvaluationOutcome {
  return {
    decision: { action },
  } as unknown as EvaluationOutcome;
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
