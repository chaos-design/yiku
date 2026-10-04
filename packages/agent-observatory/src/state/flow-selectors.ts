import {
  type AtomicDefinition,
  type AtomicFlowEvent,
  type AtomicInstanceState,
  foldAtomicEvents,
  isTraceObservationEvent,
} from "@yiku/atomic-flow/browser";
import {
  ATOMS,
  dynamicEdges,
  EDGES,
  type EdgeLayout,
  edgePairKey,
  edgeRouteKey,
} from "../data/atom-layout.js";
import type { FlowViewState } from "./flow-reducer.js";

export interface AtomRuntimeView {
  readonly count: number;
  readonly latest?: AtomicInstanceState | undefined;
  readonly latestEvent?: AtomicFlowEvent | undefined;
}

export interface EdgeRuntimeView {
  readonly active: boolean;
  readonly completed: boolean;
  readonly flowing: boolean;
  readonly latestSequence: number;
  readonly selected: boolean;
}

export interface ReplayStep {
  readonly event: AtomicFlowEvent;
  readonly replaySequence: number;
}

export function selectVisibleEvents(state: FlowViewState): readonly AtomicFlowEvent[] {
  return [...state.events.values()]
    .filter((event) => event.sequence <= state.replaySequence)
    .toSorted((left, right) => left.sequence - right.sequence);
}

export function selectTopologyEvents(state: FlowViewState): readonly AtomicFlowEvent[] {
  const topologySequence = state.topologySequence ?? state.latestSequence;
  return [...state.events.values()]
    .filter((event) => event.sequence <= topologySequence)
    .toSorted((left, right) => left.sequence - right.sequence);
}

export function selectFlowAtomDefinitions(state: FlowViewState): readonly AtomicDefinition[] {
  return [
    ...new Map(selectTopologyEvents(state).map((event) => [event.atom.key, event.atom])).values(),
  ];
}

export function selectFunctionalEvents(state: FlowViewState): readonly AtomicFlowEvent[] {
  return [...state.events.values()]
    .filter((event) => !isTraceObservationEvent(event))
    .toSorted((left, right) => left.sequence - right.sequence);
}

export function selectReplaySteps(state: FlowViewState): readonly ReplayStep[] {
  const steps: Array<{ event: AtomicFlowEvent; replaySequence: number }> = [];
  for (const event of [...state.events.values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (isTraceObservationEvent(event)) {
      const previous = steps.at(-1);
      if (previous !== undefined) {
        previous.replaySequence = event.sequence;
      }
      continue;
    }
    steps.push({
      event,
      replaySequence: event.sequence,
    });
  }
  return steps;
}

export function selectReplayPosition(
  state: FlowViewState,
  steps = selectReplaySteps(state),
): number {
  const throughSequence = state.selectedSequence ?? state.replaySequence;
  const index = steps.findLastIndex((step) => step.event.sequence <= throughSequence);
  return index === -1 ? 0 : index + 1;
}

export function selectAtomViews(state: FlowViewState): ReadonlyMap<string, AtomRuntimeView> {
  const events = selectVisibleEvents(state);
  const folded = foldAtomicEvents(events);
  const eventsBySequence = new Map(events.map((event) => [event.sequence, event]));
  const byAtom = new Map<string, AtomicInstanceState[]>();
  for (const instance of folded.instances.values()) {
    const instances = byAtom.get(instance.atom.key) ?? [];
    instances.push(instance);
    byAtom.set(instance.atom.key, instances);
  }
  return new Map(
    [...byAtom].map(([key, instances]) => {
      const latest = instances.toSorted((left, right) => right.lastSequence - left.lastSequence)[0];
      return [
        key,
        {
          count: instances.length,
          latest,
          ...(latest === undefined
            ? {}
            : { latestEvent: eventsBySequence.get(latest.lastSequence) }),
        },
      ];
    }),
  );
}

export function selectSelectedEvent(state: FlowViewState): AtomicFlowEvent | undefined {
  const event =
    state.selectedSequence === undefined ? undefined : state.events.get(state.selectedSequence);
  return event === undefined || isTraceObservationEvent(event) ? undefined : event;
}

export function selectObservedAtomKeys(state: FlowViewState): ReadonlySet<string> {
  const selectedSequence = state.selectedSequence;
  if (selectedSequence === undefined) {
    return new Set();
  }
  return new Set(
    selectVisibleEvents(state)
      .filter(
        (event) =>
          event.sequence > selectedSequence &&
          event.internal === true &&
          (event.atom.kind === "trace" || event.atom.kind === "trajectory"),
      )
      .map((event) => event.atom.key),
  );
}

export function selectFlowEdges(state: FlowViewState): readonly EdgeLayout[] {
  const events = selectTopologyEvents(state);
  const definitions = new Map(events.map((event) => [event.atom.key, event.atom]));
  const configured = [...EDGES, ...dynamicEdges([...definitions.values()])];
  const configuredRoutes = new Set(configured.map(edgeRouteKey));
  const configuredPairs = new Set(configured.map(edgePairKey));
  const knownAtoms = new Set([...ATOMS.map((atom) => atom.key), ...definitions.keys()]);
  const observed = new Map<string, EdgeLayout>();

  for (const event of events) {
    const eventEdge = event.edge;
    if (eventEdge === undefined) {
      continue;
    }
    const edge = {
      from: eventEdge.fromAtomKey,
      kind: eventEdge.kind,
      to: eventEdge.toAtomKey,
    } satisfies EdgeLayout;
    if (
      !knownAtoms.has(edge.from) ||
      !knownAtoms.has(edge.to) ||
      configuredRoutes.has(edgeRouteKey(edge)) ||
      configuredPairs.has(edgePairKey(edge)) ||
      aggregateSinkEdge(configured, event) !== undefined
    ) {
      continue;
    }
    observed.set(edgeRouteKey(edge), edge);
  }

  return [
    ...configured,
    ...[...observed.values()].toSorted((left, right) =>
      edgeRouteKey(left).localeCompare(edgeRouteKey(right)),
    ),
  ];
}

export function selectEdgeViews(
  state: FlowViewState,
  flowingEnabled = true,
  selectionEnabled = true,
): ReadonlyMap<string, EdgeRuntimeView> {
  const events = selectVisibleEvents(state);
  const edges = selectFlowEdges(state);
  const edgeByPair = new Map(edges.map((edge) => [`${edge.from}:${edge.to}`, edge]));
  const transitions = new Map<
    string,
    { readonly event: AtomicFlowEvent; readonly latestSequence: number }
  >();
  const inboundByAtom = new Map<string, string>();
  let previousAtomKey: string | undefined;
  let selectedKey: string | undefined;

  for (const event of events) {
    let key: string | undefined;
    if (event.edge !== undefined) {
      const configured =
        edges.find(
          (edge) =>
            edge.from === event.edge?.fromAtomKey &&
            edge.to === event.edge.toAtomKey &&
            edge.kind === event.edge.kind,
        ) ??
        aggregateSinkEdge(edges, event) ??
        edgeByPair.get(`${event.edge.fromAtomKey}:${event.edge.toAtomKey}`);
      if (configured !== undefined) {
        key = edgeRouteKey(configured);
      }
    } else if (event.internal !== true) {
      if (event.phase === "start" || event.phase === "scheduled") {
        const configured =
          previousAtomKey === undefined
            ? undefined
            : edgeByPair.get(`${previousAtomKey}:${event.atom.key}`);
        if (configured !== undefined && previousAtomKey !== event.atom.key) {
          key = edgeRouteKey(configured);
          inboundByAtom.set(event.atom.key, key);
        }
        previousAtomKey = event.atom.key;
      } else {
        key = inboundByAtom.get(event.atom.key);
      }
    }

    if (key !== undefined) {
      transitions.set(key, {
        event,
        latestSequence: event.sequence,
      });
      if (event.sequence === state.selectedSequence) {
        selectedKey = key;
      }
    }
  }

  let activeKey: string | undefined;
  let activeSequence = 0;
  let latestInternalKey: string | undefined;
  let latestInternalSequence = 0;
  let latestSourceKey: string | undefined;
  let latestSourceSequence = 0;
  for (const [key, transition] of transitions) {
    if (transition.event.internal === true && transition.latestSequence >= latestInternalSequence) {
      latestInternalKey = key;
      latestInternalSequence = transition.latestSequence;
    }
    if (transition.event.internal !== true && transition.latestSequence >= latestSourceSequence) {
      latestSourceKey = key;
      latestSourceSequence = transition.latestSequence;
    }
    if (
      (transition.event.phase === "start" || transition.event.phase === "delta") &&
      transition.latestSequence >= activeSequence
    ) {
      activeKey = key;
      activeSequence = transition.latestSequence;
    }
  }

  return new Map(
    edges.map((edge) => {
      const key = edgeRouteKey(edge);
      const transition = transitions.get(key);
      return [
        key,
        {
          active: key === activeKey,
          completed:
            transition !== undefined &&
            (transition.event.phase === "end" ||
              transition.event.phase === "error" ||
              transition.event.phase === "skipped"),
          flowing:
            flowingEnabled &&
            (key === activeKey || key === latestSourceKey || key === latestInternalKey),
          latestSequence: transition?.latestSequence ?? 0,
          selected: selectionEnabled && key === selectedKey,
        },
      ];
    }),
  );
}

function aggregateSinkEdge(
  edges: readonly EdgeLayout[],
  event: AtomicFlowEvent,
): EdgeLayout | undefined {
  const source =
    event.edge?.toAtomKey === "trace.append"
      ? "run"
      : event.edge?.toAtomKey === "trajectory.project"
        ? "trace.append"
        : undefined;
  return source === undefined
    ? undefined
    : edges.find((edge) => edge.from === source && edge.to === event.edge?.toAtomKey);
}
