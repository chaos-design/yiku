import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import { deriveAtomicScorecard, projectAtomicRunStatus } from "../../server/atomic-projection.js";

describe("projectAtomicRunStatus", () => {
  it("distinguishes user cancellation from runtime failure", () => {
    expect(projectAtomicRunStatus(runError("AGENT_RUN_CANCELLED", "Cancelled with Escape."))).toBe(
      "cancelled",
    );
    expect(projectAtomicRunStatus(runError("AGENT_RUN_FAILED", "Provider failed."))).toBe("failed");
    expect(
      projectAtomicRunStatus({
        ...runError("AGENT_OBSERVER_FAILED", "Observer failed."),
        atom: {
          key: "observability.degraded",
          kind: "trace",
          label: "Observability Degraded",
          level: "runtime",
        },
      }),
    ).toBe("degraded");
  });

  it("projects needs-review as a distinct terminal evaluation status", () => {
    expect(
      projectAtomicRunStatus({
        ...runError("EVAL_REQUIRED_NOT_RUN", "review"),
        atom: {
          key: "eval.gate",
          kind: "release",
          label: "Eval Gate",
          level: "runtime",
        },
        payload: { summary: "needs-review" },
        phase: "end",
      }),
    ).toBe("needs-review");
  });
});

describe("deriveAtomicScorecard", () => {
  it("projects industrial score, dimensions, counts, decision, and check status", () => {
    const events: AtomicFlowEvent[] = [
      evaluationEvent(1, "eval.trigger", "eval", "start", {
        values: { attemptId: "attempt-1" },
      }),
      evaluationEvent(2, "eval.final-output-v2", "eval", "end", {
        summary: "Output passed.",
        values: { passed: true, score: 1, status: "passed" },
      }),
      evaluationEvent(3, "eval.scorecard", "eval", "end", {
        counts: { error: 0, failed: 0, "not-run": 0, passed: 1 },
        values: {
          averageScore: 1,
          correctness: 1,
          grade: "S",
          overallScore: 1,
          passed: true,
          performance: 1,
          resourceEfficiency: 1,
          safetyReliability: 1,
        },
      }),
      evaluationEvent(4, "eval.decision", "release", "end", {
        summary: "accepted",
      }),
    ];

    expect(deriveAtomicScorecard(events)).toEqual({
      attemptId: "attempt-1",
      averageScore: 1,
      counts: { error: 0, failed: 0, "not-run": 0, passed: 1 },
      decision: "accepted",
      dimensionScores: {
        correctness: 1,
        performance: 1,
        "resource-efficiency": 1,
        "safety-reliability": 1,
      },
      grade: "S",
      overallScore: 1,
      passed: true,
      results: [
        {
          key: "final-output-v2",
          label: "eval.final-output-v2",
          passed: true,
          score: 1,
          status: "passed",
          summary: "Output passed.",
        },
      ],
    });
  });
});

function runError(code: string, summary: string): AtomicFlowEvent {
  return {
    atom: {
      key: "run",
      kind: "input",
      label: "Run",
      level: "runtime",
    },
    eventId: `event-${code}`,
    instance: { id: "run-1" },
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { code, summary },
    phase: "error",
    runId: "run-1",
    sequence: 1,
  };
}

function evaluationEvent(
  sequence: number,
  key: string,
  kind: "eval" | "release",
  phase: AtomicFlowEvent["phase"],
  payload: AtomicFlowEvent["payload"],
): AtomicFlowEvent {
  return {
    atom: {
      key,
      kind,
      label: key,
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: { id: `instance-${sequence}` },
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload,
    phase,
    runId: "run",
    sequence,
  };
}
