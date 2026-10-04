import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import { createTrajectoryView } from "../../src/state/trajectory-view.js";

describe("createTrajectoryView", () => {
  it("builds stable hierarchy, duration, replay, and instance counts", () => {
    const events = [
      event(1, "run", "run-1", "start"),
      event(2, "tool.call", "tool-1", "start", { parentId: "run-1" }),
      event(3, "tool.call", "tool-1", "end", {
        parentId: "run-1",
        summary: "first complete",
      }),
      event(4, "tool.call", "tool-2", "start", {
        iteration: 2,
        parentId: "run-1",
      }),
      event(5, "tool.call", "tool-2", "end", {
        iteration: 2,
        parentId: "run-1",
        summary: "second complete",
      }),
      event(6, "run", "run-1", "end"),
    ];

    expect(createTrajectoryView(events, 3)).toEqual([
      expect.objectContaining({
        depth: 0,
        id: "run-1",
        sequence: 1,
        status: "running",
      }),
      expect.objectContaining({
        ancestorIds: ["run-1"],
        depth: 1,
        durationMs: 1_000,
        id: "tool-1",
        instanceCount: 1,
        sequence: 3,
        summary: "first complete",
      }),
    ]);

    const completed = createTrajectoryView(events, 6);
    expect(completed.map((row) => row.id)).toEqual(["run-1", "tool-1", "tool-2"]);
    expect(completed.find((row) => row.id === "tool-1")?.instanceCount).toBe(2);
    expect(completed.find((row) => row.id === "tool-2")).toMatchObject({
      instanceCount: 2,
      iteration: 2,
    });
  });

  it("keeps missing and cyclic parents at the root", () => {
    const rows = createTrajectoryView(
      [
        event(1, "custom.a", "a", "start", { parentId: "b" }),
        event(2, "custom.b", "b", "start", { parentId: "a" }),
        event(3, "custom.c", "c", "start", { parentId: "missing" }),
      ],
      3,
    );

    expect(rows.map(({ depth, id, parentId }) => ({ depth, id, parentId }))).toEqual([
      { depth: 0, id: "a", parentId: undefined },
      { depth: 0, id: "b", parentId: undefined },
      { depth: 0, id: "c", parentId: undefined },
    ]);
  });

  it("inherits turn grouping from the nearest iterated ancestor", () => {
    const rows = createTrajectoryView(
      [
        event(1, "run", "run-1", "start"),
        event(2, "loop.turn", "turn-3", "start", {
          iteration: 3,
          parentId: "run-1",
        }),
        event(3, "tool.call", "tool-1", "start", {
          parentId: "turn-3",
        }),
      ],
      3,
    );

    expect(rows.map(({ id, turn }) => ({ id, turn }))).toEqual([
      { id: "run-1", turn: undefined },
      { id: "turn-3", turn: 3 },
      { id: "tool-1", turn: 3 },
    ]);
  });

  it("keeps turn groups when loop events do not expose an iteration", () => {
    const rows = createTrajectoryView(
      [
        event(1, "run", "run-1", "start"),
        event(2, "loop.turn", "turn-a", "start", {
          parentId: "run-1",
        }),
        event(3, "tool.call", "tool-a", "start", {
          parentId: "turn-a",
        }),
        event(4, "loop.turn", "turn-b", "start", {
          parentId: "run-1",
        }),
      ],
      4,
    );

    expect(rows.map(({ id, turn }) => ({ id, turn }))).toEqual([
      { id: "run-1", turn: undefined },
      { id: "turn-a", turn: 1 },
      { id: "tool-a", turn: 1 },
      { id: "turn-b", turn: 2 },
    ]);
  });

  it("returns an empty view without requiring a synthetic run", () => {
    expect(createTrajectoryView([], 0)).toEqual([]);
  });

  it("uses failures as summaries and tolerates invalid timing data", () => {
    const start = {
      ...event(1, "tool.call", "failed", "start"),
      occurredAt: "invalid",
    };
    const failed = {
      ...event(2, "tool.call", "failed", "error"),
      occurredAt: "also-invalid",
      payload: {
        summary: "tool failed",
      },
    };
    const row = createTrajectoryView([start, failed], 2)[0];

    expect(row).not.toHaveProperty("durationMs");
    expect(row).toMatchObject({
      status: "failed",
      summary: "tool failed",
    });
  });
});

function event(
  sequence: number,
  atomKey: string,
  instanceId: string,
  phase: AtomicFlowEvent["phase"],
  options: {
    readonly iteration?: number;
    readonly parentId?: string;
    readonly summary?: string;
  } = {},
): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind: atomKey === "tool.call" ? "tool" : "input",
      label: atomKey,
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: instanceId,
      ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
    },
    occurredAt: new Date(sequence * 1_000).toISOString(),
    ...(options.summary !== undefined ? { payload: { summary: options.summary } } : {}),
    phase,
    runId: "run",
    sequence,
  };
}
