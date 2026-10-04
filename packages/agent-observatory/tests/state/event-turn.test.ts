import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import { createEventTurnIndex } from "../../src/state/event-turn.js";

describe("createEventTurnIndex", () => {
  it("inherits explicit turns through instance parents and chronological events", () => {
    const events = [
      event(1, "run", "run-1"),
      event(2, "loop.turn", "turn-2", { iteration: 2, parentId: "run-1" }),
      event(3, "model.invoke", "model-1", { parentId: "turn-2" }),
      event(4, "observation", "orphan-observation"),
      event(5, "stage.finish", "stage-1"),
    ];

    const index = createEventTurnIndex(events);

    expect(index.byInstanceId.get("model-1")).toBe(2);
    expect([...index.bySequence]).toEqual([
      [2, 2],
      [3, 2],
      [4, 2],
    ]);
    expect(index.turns).toEqual([2]);
  });

  it("assigns deterministic turns when loop events omit iteration", () => {
    const events = [
      event(1, "loop.turn", "turn-a"),
      event(2, "tool.call", "tool-a", { parentId: "turn-a" }),
      event(3, "loop.turn", "turn-b"),
      event(4, "tool.call", "tool-b", { parentId: "turn-b" }),
    ];

    const index = createEventTurnIndex(events);

    expect(index.byInstanceId.get("turn-a")).toBe(1);
    expect(index.byInstanceId.get("tool-a")).toBe(1);
    expect(index.byInstanceId.get("turn-b")).toBe(2);
    expect(index.bySequence.get(4)).toBe(2);
    expect(index.turns).toEqual([1, 2]);
  });

  it("reads iteration from payload values and tolerates cyclic parents", () => {
    const events = [
      {
        ...event(1, "loop.turn", "turn-a", { parentId: "turn-b" }),
        payload: { values: { iteration: 3 } },
      },
      event(2, "tool.call", "turn-b", { parentId: "turn-a" }),
    ];

    const index = createEventTurnIndex(events);

    expect(index.byInstanceId.get("turn-a")).toBe(3);
    expect(index.byInstanceId.get("turn-b")).toBe(3);
  });
});

function event(
  sequence: number,
  atomKey: string,
  instanceId: string,
  instance: {
    readonly iteration?: number;
    readonly parentId?: string;
  } = {},
): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind:
        atomKey === "loop.turn"
          ? "loop"
          : atomKey === "tool.call"
            ? "tool"
            : atomKey === "model.invoke"
              ? "model"
              : "input",
      label: atomKey,
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: instanceId,
      ...instance,
    },
    occurredAt: new Date(sequence * 1_000).toISOString(),
    phase: "start",
    runId: "run-1",
    sequence,
  };
}
