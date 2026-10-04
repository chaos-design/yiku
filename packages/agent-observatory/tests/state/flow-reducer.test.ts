import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import { flowReducer, INITIAL_FLOW_STATE } from "../../src/state/flow-reducer.js";
import {
  selectAtomViews,
  selectEdgeViews,
  selectFlowAtomDefinitions,
  selectFunctionalEvents,
  selectObservedAtomKeys,
  selectReplayPosition,
  selectReplaySteps,
  selectSelectedEvent,
  selectVisibleEvents,
} from "../../src/state/flow-selectors.js";

describe("flowReducer", () => {
  it("loads, receives, deduplicates, selects, seeks, and returns live", () => {
    const first = atomicEvent(1, "event-1", "loop.turn", "start");
    const second = atomicEvent(2, "event-2", "loop.turn", "end");
    let state = flowReducer(INITIAL_FLOW_STATE, {
      events: [first],
      type: "load",
    });
    state = flowReducer(state, { event: second, type: "receive" });
    const duplicate = flowReducer(state, { event: second, type: "receive" });

    expect(duplicate).toBe(state);
    expect(state).toMatchObject({
      latestSequence: 2,
      live: true,
      replaySequence: 2,
      selectedSequence: 2,
      topologySequence: 2,
    });

    const highlighted = flowReducer(state, { sequence: 1, type: "highlight" });
    expect(highlighted).toMatchObject({
      latestSequence: 2,
      live: true,
      replaySequence: 2,
      selectedSequence: 1,
      topologySequence: 2,
    });
    expect(selectVisibleEvents(highlighted)).toEqual([first, second]);

    state = flowReducer(state, { sequence: 1, type: "select" });
    expect(state).toMatchObject({ live: false, replaySequence: 1, selectedSequence: 1 });
    expect(selectVisibleEvents(state)).toEqual([first]);
    expect(selectSelectedEvent(state)).toEqual(first);
    expect(selectAtomViews(state).get("loop.turn")).toMatchObject({
      count: 1,
      latest: {
        status: "running",
      },
    });

    state = flowReducer(state, { sequence: 99, type: "seek" });
    expect(state.replaySequence).toBe(2);
    state = flowReducer(state, { type: "live" });
    expect(state.live).toBe(true);
    state = flowReducer(state, { type: "toggle-deep" });
    expect(state.deepView).toBe(false);
    expect(flowReducer(state, { type: "reset" })).toBe(INITIAL_FLOW_STATE);
  });

  it("loads and resumes live when an active run receives events", () => {
    let state = flowReducer(INITIAL_FLOW_STATE, { events: [], type: "load" });
    state = flowReducer(state, {
      event: atomicEvent(1, "event-1", "input.prompt", "start"),
      type: "receive",
    });
    state = flowReducer(state, { sequence: 1, type: "select" });
    state = flowReducer(state, {
      event: atomicEvent(2, "event-2", "loop.turn", "start"),
      type: "receive",
    });

    expect(state).toMatchObject({
      latestSequence: 2,
      live: true,
      replaySequence: 2,
      selectedSequence: 2,
      topologySequence: 2,
    });
    expect(selectFlowAtomDefinitions(state).map((definition) => definition.key)).toEqual([
      "input.prompt",
      "loop.turn",
    ]);
  });

  it("clears selection without changing the replay boundary or live mode", () => {
    const first = atomicEvent(1, "event-1", "loop.turn", "start");
    const second = atomicEvent(2, "event-2", "tool.call", "end");
    let state = flowReducer(INITIAL_FLOW_STATE, {
      events: [first, second],
      type: "load",
    });
    state = flowReducer(state, { sequence: 1, type: "select" });
    const cleared = flowReducer(state, { type: "clear-selection" });

    expect(cleared).toMatchObject({
      latestSequence: 2,
      live: false,
      replaySequence: 1,
    });
    expect(cleared.selectedSequence).toBeUndefined();
    expect(selectSelectedEvent(cleared)).toBeUndefined();
    expect(selectReplayPosition(cleared, selectReplaySteps(cleared))).toBe(1);
  });

  it("keeps the executing atom selected while projecting Trace observations", () => {
    const prompt = atomicEvent(1, "event-1", "input.prompt", "end");
    const toolCall = atomicEvent(2, "event-2", "tool.call", "start");
    let state = flowReducer(INITIAL_FLOW_STATE, {
      events: [prompt, toolCall],
      type: "load",
    });
    state = flowReducer(state, { sequence: 1, type: "select" });
    state = flowReducer(state, {
      event: internalEvent(3, "trace.append", "trace"),
      type: "receive",
    });
    state = flowReducer(state, {
      event: internalEvent(4, "trajectory.project", "trajectory"),
      type: "receive",
    });

    expect(selectSelectedEvent(state)).toEqual(toolCall);
    expect([...selectObservedAtomKeys(state)]).toEqual(["trace.append", "trajectory.project"]);

    state = flowReducer(state, {
      event: atomicEvent(5, "event-5", "observation", "start"),
      type: "receive",
    });
    expect(selectObservedAtomKeys(state).size).toBe(0);
  });

  it("maps Trace observations to functional replay steps", () => {
    const first = atomicEvent(1, "event-1", "tool.call", "end");
    const trace = internalEvent(2, "trace.append", "trace");
    const trajectory = internalEvent(3, "trajectory.project", "trajectory");
    const second = atomicEvent(4, "event-4", "observation", "end");
    const trailingTrace = internalEvent(5, "trace.append", "trace");
    let state = flowReducer(INITIAL_FLOW_STATE, {
      events: [first, trace, trajectory, second, trailingTrace],
      type: "load",
    });
    const steps = selectReplaySteps(state);

    expect(selectFunctionalEvents(state)).toEqual([first, second]);
    expect(steps).toEqual([
      {
        event: first,
        replaySequence: 3,
      },
      {
        event: second,
        replaySequence: 5,
      },
    ]);
    expect(selectReplayPosition(state, steps)).toBe(2);

    state = flowReducer(state, { sequence: 3, type: "seek" });
    expect(state).toMatchObject({
      replaySequence: 3,
      selectedSequence: 1,
    });
    expect(selectSelectedEvent(state)).toEqual(first);
    expect([...selectObservedAtomKeys(state)]).toEqual(["trace.append", "trajectory.project"]);

    state = flowReducer(state, { sequence: 2, type: "select" });
    expect(state).toMatchObject({
      replaySequence: 3,
      selectedSequence: 1,
    });
    expect(selectSelectedEvent(state)).toEqual(first);
  });

  it("projects active, completed, selected, and explicit edge transitions", () => {
    const prompt = atomicEvent(1, "event-1", "input.prompt", "start");
    const runStart = {
      ...atomicEvent(2, "event-2", "run", "start"),
      edge: {
        fromAtomKey: "input.prompt",
        kind: "execution" as const,
        toAtomKey: "run",
      },
    };
    let state = flowReducer(INITIAL_FLOW_STATE, {
      events: [prompt, runStart],
      type: "load",
    });
    state = flowReducer(state, { sequence: 2, type: "seek" });
    const inputKey = "input.prompt:run:execution";

    expect(selectEdgeViews(state).get(inputKey)).toEqual({
      active: true,
      completed: false,
      flowing: true,
      latestSequence: 2,
      selected: true,
    });

    state = flowReducer(state, {
      event: {
        ...atomicEvent(3, "event-3", "run", "end"),
        edge: {
          fromAtomKey: "input.prompt",
          kind: "execution",
          toAtomKey: "run",
        },
      },
      type: "receive",
    });
    expect(selectEdgeViews(state).get(inputKey)).toMatchObject({
      active: false,
      completed: true,
      flowing: true,
      latestSequence: 3,
    });

    const receipt = {
      ...atomicEvent(4, "event-4", "trajectory.project", "end"),
      atom: {
        key: "trajectory.project",
        kind: "trajectory" as const,
        label: "Trajectory Project",
        level: "runtime" as const,
      },
      edge: {
        fromAtomKey: "model.invoke",
        kind: "persistence" as const,
        toAtomKey: "trajectory.project",
      },
      internal: true,
    };
    state = flowReducer(state, { event: receipt, type: "receive" });
    const edgeViews = selectEdgeViews(state);
    expect(edgeViews.get("trace.append:trajectory.project:persistence")).toMatchObject({
      completed: true,
      flowing: true,
      latestSequence: 4,
    });
    expect(edgeViews.get(inputKey)).toMatchObject({
      flowing: true,
      latestSequence: 3,
    });

    const terminalEdgeViews = selectEdgeViews(state, false);
    expect([...terminalEdgeViews.values()].every((view) => !view.flowing)).toBe(true);
    expect(terminalEdgeViews.get(inputKey)).toMatchObject({
      completed: true,
      selected: true,
    });
    expect(terminalEdgeViews.get("trace.append:trajectory.project:persistence")).toMatchObject({
      completed: true,
    });
  });
});

function atomicEvent(
  sequence: number,
  eventId: string,
  atomKey: string,
  phase: AtomicFlowEvent["phase"],
): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind: "loop",
      label: "Loop Turn",
      level: "runtime",
    },
    eventId,
    instance: {
      id: "turn-1",
      iteration: 1,
    },
    occurredAt: "2026-07-31T00:00:00.000Z",
    phase,
    runId: "run",
    sequence,
  };
}

function internalEvent(
  sequence: number,
  atomKey: string,
  kind: AtomicFlowEvent["atom"]["kind"],
): AtomicFlowEvent {
  return {
    ...atomicEvent(sequence, `event-${sequence}`, atomKey, "end"),
    atom: {
      key: atomKey,
      kind,
      label: atomKey,
      level: "runtime",
    },
    internal: true,
  };
}
