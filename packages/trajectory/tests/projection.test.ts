import type { AtomicDefinition, AtomicFlowEvent } from "@yiku/atomic-flow";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import { observeTrajectory, projectTrajectory } from "../src/projection.js";

const RUN_ATOM = atom("run", "input", "Run");
const TOOL_ATOM = atom("tool.call", "tool", "Tool Call");

describe("projectTrajectory", () => {
  it("projects ordered Atomic instances and replay prefixes", () => {
    const events = [
      event(4, "end", TOOL_ATOM, "tool-1", {
        parentId: "run-1",
        summary: "read complete",
      }),
      event(1, "start", RUN_ATOM, "run-1"),
      event(3, "delta", TOOL_ATOM, "tool-1", {
        parentId: "run-1",
        summary: "reading",
      }),
      event(2, "start", TOOL_ATOM, "tool-1", {
        iteration: 2,
        parentId: "run-1",
        summary: "read",
      }),
      event(5, "end", RUN_ATOM, "run-1"),
    ];

    expect(projectTrajectory(events)).toEqual({
      endedAt: occurredAt(5),
      id: "run-1",
      startedAt: occurredAt(1),
      steps: [
        expect.objectContaining({
          endedAt: occurredAt(5),
          id: "run-1",
          status: "completed",
        }),
        expect.objectContaining({
          endedAt: occurredAt(4),
          id: "tool-1",
          iteration: 2,
          output: {
            summary: "read complete",
          },
          parentId: "run-1",
          status: "completed",
        }),
      ],
    });

    const replay = projectTrajectory(events, { throughSequence: 3 });
    expect(replay).not.toHaveProperty("endedAt");
    expect(replay).toMatchObject({
      steps: [
        expect.objectContaining({ id: "run-1", status: "running" }),
        expect.objectContaining({
          id: "tool-1",
          output: { summary: "reading" },
          status: "running",
        }),
      ],
    });
  });

  it("filters internal observation receipts and retains missing parents", () => {
    const trajectory = projectTrajectory([
      event(1, "start", TOOL_ATOM, "orphan", {
        parentId: "missing",
      }),
      {
        ...event(2, "end", atom("trajectory.project", "trajectory", "Project"), "receipt"),
        internal: true,
      },
      event(3, "skipped", TOOL_ATOM, "orphan", {
        parentId: "missing",
        summary: "not needed",
      }),
    ]);

    expect(trajectory.steps).toEqual([
      expect.objectContaining({
        id: "orphan",
        parentId: "missing",
        status: "completed",
      }),
    ]);
  });

  it("rejects mixed runs and requires an ID only for empty input", () => {
    expect(() =>
      projectTrajectory([
        event(1, "start", RUN_ATOM, "first"),
        { ...event(2, "end", RUN_ATOM, "second"), runId: "other" },
      ]),
    ).toThrow("must belong to one run");
    expect(() => projectTrajectory([])).toThrow("run ID is required");
    expect(projectTrajectory([], { runId: "empty" })).toEqual({
      id: "empty",
      startedAt: new Date(0).toISOString(),
      steps: [],
    });
  });
});

describe("AtomicTrajectoryProjection", () => {
  it("matches static projection, isolates listeners, and closes idempotently", () => {
    const flow = new AtomicFlowRun({
      clock: sequenceClock(),
      eventIdGenerator: sequenceId("event"),
      instanceIdGenerator: sequenceId("instance"),
      runId: "live",
    });
    const projection = observeTrajectory(flow);
    const listener = vi.fn();
    projection.subscribe(() => {
      throw new Error("observer failed");
    });
    const unsubscribe = projection.subscribe(listener);
    const run = flow.start({
      atom: RUN_ATOM,
      instanceId: "run-live",
    });
    run.end();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(projection.snapshot().startedAt).toBe(new Date(1_000).toISOString());
    expect(projection.snapshot()).toEqual(
      projectTrajectory(flow.snapshot().events, {
        runId: "live",
        startedAt: projection.snapshot().startedAt,
      }),
    );

    unsubscribe();
    unsubscribe();
    projection.close();
    projection.close();
    const closedListener = vi.fn();
    const unsubscribeClosed = projection.subscribe(closedListener);
    unsubscribeClosed();
    flow.start({ atom: TOOL_ATOM, instanceId: "after-close" }).end();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(closedListener).not.toHaveBeenCalled();
  });
});

function atom(key: string, kind: AtomicDefinition["kind"], label: string): AtomicDefinition {
  return {
    key,
    kind,
    label,
    level: "runtime",
  };
}

function event(
  sequence: number,
  phase: AtomicFlowEvent["phase"],
  definition: AtomicDefinition,
  instanceId: string,
  options: {
    readonly iteration?: number;
    readonly parentId?: string;
    readonly summary?: string;
  } = {},
): AtomicFlowEvent {
  return {
    atom: definition,
    eventId: `event-${sequence}`,
    instance: {
      id: instanceId,
      ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
    },
    occurredAt: occurredAt(sequence),
    ...(options.summary !== undefined ? { payload: { summary: options.summary } } : {}),
    phase,
    runId: "run-1",
    sequence,
  };
}

function occurredAt(sequence: number): string {
  return new Date(sequence * 1_000).toISOString();
}

function sequenceClock(): () => Date {
  let sequence = 0;
  return () => {
    sequence += 1;
    return new Date(sequence * 1_000);
  };
}

function sequenceId(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };
}
