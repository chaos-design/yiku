import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import type { FlowViewState } from "../../src/state/flow-reducer.js";
import {
  selectAtomViews,
  selectEdgeViews,
  selectFlowAtomDefinitions,
  selectFlowEdges,
  selectFunctionalEvents,
  selectObservedAtomKeys,
  selectReplayPosition,
  selectReplaySteps,
  selectSelectedEvent,
  selectTopologyEvents,
  selectVisibleEvents,
} from "../../src/state/flow-selectors.js";

describe("selectEdgeViews", () => {
  it("uses the emitted Tool Call edge for every User Question phase", () => {
    const requested = stateWithUserQuestion("requested");
    const resolved = stateWithUserQuestion("resolved");

    const edgeKey = "tool.call:user.question:execution";
    expect(selectEdgeViews(requested).get(edgeKey)?.flowing).toBe(true);
    expect(selectEdgeViews(resolved).get(edgeKey)?.flowing).toBe(true);
  });

  it("adds unknown explicit edges and reuses fixed routes for known endpoint pairs", () => {
    const source = flowEvent(1, "tool.extension", "tool");
    const target = {
      ...flowEvent(2, "reply.extension", "reply"),
      edge: {
        fromAtomKey: source.atom.key,
        kind: "data" as const,
        toAtomKey: "reply.extension",
      },
      phase: "end" as const,
    };
    const extensionState: FlowViewState = {
      deepView: false,
      events: new Map([
        [source.sequence, source],
        [target.sequence, target],
      ]),
      latestSequence: 2,
      live: false,
      replaySequence: 2,
      selectedSequence: 2,
    };

    expect(
      selectFlowEdges(extensionState).map((edge) => `${edge.from}:${edge.to}:${edge.kind}`),
    ).toContain("tool.extension:reply.extension:data");
    expect(
      selectEdgeViews(extensionState).get("tool.extension:reply.extension:data"),
    ).toMatchObject({
      completed: true,
      latestSequence: 2,
      selected: true,
    });

    const context = flowEvent(1, "memory.context-inject", "memory");
    const run = {
      ...flowEvent(2, "run", "input"),
      edge: {
        fromAtomKey: context.atom.key,
        kind: "execution" as const,
        toAtomKey: "run",
      },
    };
    const configuredState: FlowViewState = {
      ...extensionState,
      events: new Map([
        [context.sequence, context],
        [run.sequence, run],
      ]),
    };

    expect(
      selectFlowEdges(configuredState).some(
        (edge) =>
          edge.from === "memory.context-inject" && edge.to === "run" && edge.kind === "execution",
      ),
    ).toBe(false);
    expect(
      selectEdgeViews(configuredState).get("memory.context-inject:run:data")?.latestSequence,
    ).toBe(2);
  });

  it("projects replay, selection, observations and explicit sink edges", () => {
    const trace = flowEvent(1, "trace.append", "trace", true);
    const run = flowEvent(2, "run", "input");
    const turn = flowEvent(3, "loop.turn", "loop");
    const observation = {
      ...flowEvent(4, "observation", "loop"),
      phase: "end" as const,
    };
    const trajectory = {
      ...flowEvent(5, "trajectory.project", "trajectory", true),
      edge: {
        fromAtomKey: "custom",
        kind: "persistence" as const,
        toAtomKey: "trajectory.project",
      },
    };
    const state: FlowViewState = {
      deepView: false,
      events: new Map(
        [trace, run, turn, observation, trajectory].map((event) => [event.sequence, event]),
      ),
      latestSequence: 5,
      live: false,
      replaySequence: 5,
      selectedSequence: 3,
    };

    expect(selectVisibleEvents(state)).toHaveLength(5);
    expect(selectFunctionalEvents(state)).toEqual([run, turn, observation]);
    expect(selectReplaySteps(state)).toMatchObject([
      { event: run, replaySequence: 2 },
      { event: turn, replaySequence: 3 },
      { event: observation, replaySequence: 5 },
    ]);
    expect(selectReplayPosition(state)).toBe(2);
    expect(selectReplayPosition({ ...state, selectedSequence: 0 })).toBe(0);
    expect(selectSelectedEvent(state)).toBe(turn);
    expect(selectSelectedEvent({ ...state, selectedSequence: 1 })).toBeUndefined();
    expect(selectSelectedEvent({ ...state, selectedSequence: undefined })).toBeUndefined();
    expect(selectObservedAtomKeys(state)).toEqual(new Set(["trajectory.project"]));
    expect(selectObservedAtomKeys({ ...state, selectedSequence: undefined })).toEqual(new Set());
    expect(selectAtomViews(state).get("run")?.count).toBe(1);
    expect(selectAtomViews(state).get("run")?.latestEvent).toBe(run);
    const edges = selectEdgeViews(state, false, false);
    expect([...edges.values()].every((edge) => !edge.flowing && !edge.selected)).toBe(true);
    expect(edges.get("trace.append:trajectory.project:persistence")?.latestSequence).toBe(5);
  });

  it("replays correlated Skill and subagent spans using their stable instance IDs", () => {
    const events: readonly AtomicFlowEvent[] = [
      {
        ...flowEvent(1, "skill.execute", "skill"),
        instance: { id: "skill-worker-1" },
      },
      {
        ...flowEvent(2, "skill.execute", "skill"),
        instance: { id: "skill-worker-1" },
        phase: "end",
      },
      {
        ...flowEvent(3, "agent.execute", "agent"),
        instance: { id: "agent-1" },
      },
      {
        ...flowEvent(4, "agent.execute", "agent"),
        instance: { id: "agent-1" },
        phase: "end",
      },
    ];
    const state: FlowViewState = {
      deepView: false,
      events: new Map(events.map((event) => [event.sequence, event])),
      latestSequence: 4,
      live: false,
      replaySequence: 1,
      selectedSequence: 1,
    };

    expect(selectAtomViews(state).get("skill.execute")?.latest?.status).toBe("running");
    expect(
      selectAtomViews({ ...state, replaySequence: 2, selectedSequence: 2 }).get("skill.execute")
        ?.latest?.status,
    ).toBe("completed");
    expect(
      selectAtomViews({ ...state, replaySequence: 2, selectedSequence: 2 }).get("skill.execute")
        ?.latestEvent?.sequence,
    ).toBe(2);
    expect(
      selectAtomViews({ ...state, replaySequence: 3, selectedSequence: 3 }).get("agent.execute")
        ?.latest?.status,
    ).toBe("running");
    expect(
      selectAtomViews({ ...state, replaySequence: 4, selectedSequence: 4 }).get("agent.execute")
        ?.latest?.status,
    ).toBe("completed");
  });

  it("freezes topology at the loaded snapshot while live events continue", () => {
    const loaded = flowEvent(1, "run", "input");
    const live = {
      ...flowEvent(2, "eval.live-extension", "eval"),
      edge: {
        fromAtomKey: "eval.trigger",
        kind: "execution" as const,
        toAtomKey: "eval.live-extension",
      },
    };
    const state: FlowViewState = {
      deepView: true,
      events: new Map([
        [loaded.sequence, loaded],
        [live.sequence, live],
      ]),
      latestSequence: 2,
      live: true,
      replaySequence: 2,
      selectedSequence: 2,
      topologySequence: 1,
    };

    expect(selectTopologyEvents(state)).toEqual([loaded]);
    expect(selectFlowAtomDefinitions(state).map((definition) => definition.key)).toEqual(["run"]);
    expect(selectFlowEdges(state).some((edge) => edge.to === "eval.live-extension")).toBe(false);
    expect(selectAtomViews(state).has("eval.live-extension")).toBe(true);
  });
});

function stateWithUserQuestion(summary: "requested" | "resolved"): FlowViewState {
  const event: AtomicFlowEvent = {
    atom: {
      key: "user.question",
      kind: "input",
      label: "User Question",
      level: "runtime",
    },
    eventId: `user-question-${summary}`,
    edge: {
      fromAtomKey: "tool.call",
      kind: "execution",
      toAtomKey: "user.question",
    },
    instance: {
      id: `user-question-${summary}`,
    },
    occurredAt: "2026-08-06T00:00:00.000Z",
    payload: {
      summary,
    },
    phase: "end",
    runId: "run-1",
    sequence: 1,
  };

  return {
    deepView: false,
    events: new Map([[1, event]]),
    latestSequence: 1,
    live: true,
    replaySequence: 1,
    selectedSequence: 1,
  };
}

function flowEvent(
  sequence: number,
  key: string,
  kind: AtomicFlowEvent["atom"]["kind"],
  internal = false,
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
    ...(internal ? { internal: true } : {}),
    occurredAt: `2026-08-07T00:00:0${sequence}.000Z`,
    phase: "start",
    runId: "run-1",
    sequence,
  };
}
