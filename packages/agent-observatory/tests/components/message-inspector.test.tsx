import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageInspector } from "../../src/components/message-inspector.js";
import type { RunDetail } from "../../src/types.js";

describe("MessageInspector", () => {
  it("renders run input, output, metadata, and the complete event envelope", () => {
    const event = atomicEvent();
    const run: RunDetail = {
      createdAt: "2026-08-01T12:00:00.000Z",
      evalMode: "async",
      eventCount: 1,
      events: [event],
      kind: "control",
      output: "Completed output",
      prompt: "Review the runtime",
      runId: "run-1",
      source: "external",
      status: "completed",
      updatedAt: "2026-08-01T12:34:56.789Z",
    };
    const markup = renderToStaticMarkup(<MessageInspector event={event} run={run} />);

    expect(markup).toContain("EVENT INSPECTOR");
    expect(markup).not.toContain("quality gate scorecard");
    expect(markup).toContain("Review the runtime");
    expect(markup).toContain("Completed output");
    expect(markup).toContain("event-1");
    expect(markup).toContain("2026-08-01T12:34:56.789Z");
    expect(markup).toContain("correlation");
    expect(markup).toContain("profile-1");
    expect(markup).toContain("agent-1");
    expect(markup).toContain("task-1");
    expect(markup).toContain("digest-1");
    expect(markup).toContain("control");
    expect(markup).toContain("json-key");
    expect(markup).toContain("json-string");
  });

  it("renders empty, event-only and run-only states with all JSON value kinds", () => {
    const empty = renderToStaticMarkup(<MessageInspector />);
    expect(empty).toContain("No event selected");
    expect(empty).toContain("Select an atomic log row");

    const event = {
      ...atomicEvent(),
      payload: {
        values: {
          array: [1, true, null, "value"],
          empty: [],
          object: {},
        },
      },
    };
    const eventOnly = renderToStaticMarkup(<MessageInspector event={event} />);
    expect(eventOnly).toContain("Sequence 1");
    expect(eventOnly).toContain("json-number");
    expect(eventOnly).toContain("json-boolean");
    expect(eventOnly).toContain("json-null");
    expect(eventOnly).toContain("[]");
    expect(eventOnly).toContain("{}");

    const runOnly = renderToStaticMarkup(
      <MessageInspector
        run={{
          createdAt: "2026-08-01T12:00:00.000Z",
          error: "failed",
          evalMode: "blocking",
          eventCount: 0,
          events: [],
          prompt: "Prompt",
          runId: "run-only",
          scorecard: {
            averageScore: 0,
            counts: {
              error: 1,
              failed: 0,
              "not-run": 0,
              passed: 2,
            },
            decision: "needs-review",
            dimensionScores: {
              correctness: 0.5,
              performance: 1,
              "resource-efficiency": 0.8,
              "safety-reliability": 1,
            },
            grade: "C",
            overallScore: 0.7,
            passed: false,
            results: [],
          },
          sessionId: "session",
          source: "studio",
          status: "failed",
          updatedAt: "2026-08-01T12:00:01.000Z",
        }}
      />,
    );
    expect(runOnly).toContain("run-only");
    expect(runOnly).toContain("failed");
    expect(runOnly).toContain("eval-summary");
    expect(runOnly).toContain("Run evaluation");
    expect(runOnly).toContain("Run-level, not event-specific");
    expect(runOnly).toContain("needs-review");
    expect(runOnly).toContain("70.0");
    expect(runOnly).toContain('data-passed="false"');
    expect(runOnly).toContain("resource efficiency");
    expect(runOnly).toContain("eval-dimension-bar");
    expect(runOnly).toContain("width:50%");
    expect(runOnly).toContain('aria-label="Collapse quality gate scorecard"');
    expect(runOnly).toContain('aria-controls="run-evaluation-scorecard"');
    expect(runOnly).toContain('aria-expanded="true"');
    expect(runOnly).toContain("eval-summary-region is-expanded");
  });

  it("correlates parameters and results for either event in the selected instance", () => {
    const start: AtomicFlowEvent = {
      ...atomicEvent(),
      eventId: "tool-start",
      instance: { id: "tool-1" },
      payload: {
        values: {
          input: {
            command: "pnpm test",
          },
          toolName: "bashTool",
        },
      },
      phase: "start",
      sequence: 2,
    };
    const end: AtomicFlowEvent = {
      ...start,
      eventId: "tool-end",
      payload: {
        values: {
          output: "passed",
          toolName: "bashTool",
        },
      },
      phase: "end",
      sequence: 3,
    };
    const final: AtomicFlowEvent = {
      ...end,
      atom: {
        key: "reply.final",
        kind: "reply",
        label: "Final Reply",
        level: "runtime",
      },
      eventId: "reply-end",
      instance: { id: "reply-1" },
      payload: {
        values: {
          output: "Run completed",
        },
      },
      sequence: 4,
    };
    const events = [start, end, final];

    for (const selected of [start, end]) {
      const markup = renderToStaticMarkup(
        <MessageInspector
          event={selected}
          events={events}
          run={{
            createdAt: "2026-08-01T12:00:00.000Z",
            evalMode: "blocking",
            eventCount: events.length,
            events,
            prompt: "Run tests",
            runId: "run-1",
            source: "studio",
            status: "completed",
            updatedAt: "2026-08-01T12:00:01.000Z",
          }}
        />,
      );

      expect(markup).toContain("parameters");
      expect(markup).toContain("pnpm test");
      expect(markup).toContain("result");
      expect(markup).toContain("passed");
      expect(markup).toContain("Run completed");
    }
  });
});

function atomicEvent(): AtomicFlowEvent {
  return {
    atom: {
      key: "loop.turn",
      kind: "loop",
      label: "Loop Turn",
      level: "runtime",
    },
    eventId: "event-1",
    instance: {
      id: "turn-1",
      iteration: 1,
    },
    occurredAt: "2026-08-01T12:34:56.789Z",
    payload: {
      summary: "Turn completed",
      values: {
        agentId: "agent-1",
        digest: "digest-1",
        profileId: "profile-1",
        taskId: "task-1",
        tokens: 42,
      },
    },
    phase: "end",
    runId: "run-1",
    sequence: 1,
  };
}
