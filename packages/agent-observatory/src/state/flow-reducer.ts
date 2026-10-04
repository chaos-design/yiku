import { type AtomicFlowEvent, isTraceObservationEvent } from "@yiku/atomic-flow/browser";

export interface FlowViewState {
  readonly deepView: boolean;
  readonly events: ReadonlyMap<number, AtomicFlowEvent>;
  readonly latestSequence: number;
  readonly live: boolean;
  readonly replaySequence: number;
  readonly selectedSequence?: number | undefined;
  readonly topologySequence?: number | undefined;
}

export type FlowAction =
  | { readonly events: readonly AtomicFlowEvent[]; readonly type: "load" }
  | { readonly event: AtomicFlowEvent; readonly type: "receive" }
  | { readonly type: "clear-selection" }
  | { readonly sequence: number; readonly type: "highlight" }
  | { readonly sequence: number; readonly type: "select" }
  | { readonly sequence: number; readonly type: "seek" }
  | { readonly type: "live" }
  | { readonly type: "toggle-deep" }
  | { readonly type: "reset" };

export const INITIAL_FLOW_STATE: FlowViewState = {
  deepView: true,
  events: new Map(),
  latestSequence: 0,
  live: true,
  replaySequence: 0,
  topologySequence: 0,
};

export function flowReducer(state: FlowViewState, action: FlowAction): FlowViewState {
  switch (action.type) {
    case "load": {
      const events = new Map(action.events.map((event) => [event.sequence, event]));
      const latestSequence = maxSequence(events);
      return {
        ...state,
        events,
        latestSequence,
        live: true,
        replaySequence: latestSequence,
        selectedSequence: latestFunctionalSequence(events),
        topologySequence: latestSequence,
      };
    }
    case "receive": {
      const existing = state.events.get(action.event.sequence);
      if (existing?.eventId === action.event.eventId) {
        return state;
      }
      const events = new Map(state.events);
      events.set(action.event.sequence, action.event);
      const latestSequence = Math.max(state.latestSequence, action.event.sequence);
      return {
        ...state,
        events,
        latestSequence,
        live: true,
        replaySequence: latestSequence,
        selectedSequence: isTraceObservationEvent(action.event)
          ? latestFunctionalSequence(events)
          : action.event.sequence,
        topologySequence: latestSequence,
      };
    }
    case "clear-selection":
      return {
        ...state,
        selectedSequence: undefined,
      };
    case "highlight":
      return {
        ...state,
        selectedSequence: latestFunctionalSequence(state.events, action.sequence),
      };
    case "select": {
      const selectedSequence = latestFunctionalSequence(state.events, action.sequence);
      return {
        ...state,
        live: false,
        replaySequence: replayBoundary(state.events, selectedSequence, state.latestSequence),
        selectedSequence,
      };
    }
    case "seek": {
      const replaySequence = Math.min(action.sequence, state.latestSequence);
      return {
        ...state,
        live: action.sequence >= state.latestSequence,
        replaySequence,
        selectedSequence: latestFunctionalSequence(state.events, replaySequence),
      };
    }
    case "live":
      return {
        ...state,
        live: true,
        replaySequence: state.latestSequence,
        selectedSequence: latestFunctionalSequence(state.events),
      };
    case "toggle-deep":
      return {
        ...state,
        deepView: !state.deepView,
      };
    case "reset":
      return INITIAL_FLOW_STATE;
  }
}

function maxSequence(events: ReadonlyMap<number, AtomicFlowEvent>): number {
  let maximum = 0;
  for (const sequence of events.keys()) {
    maximum = Math.max(maximum, sequence);
  }
  return maximum;
}

function latestFunctionalSequence(
  events: ReadonlyMap<number, AtomicFlowEvent>,
  throughSequence = Number.POSITIVE_INFINITY,
): number | undefined {
  let latest: number | undefined;
  for (const event of events.values()) {
    if (
      event.sequence <= throughSequence &&
      !isTraceObservationEvent(event) &&
      (latest === undefined || event.sequence > latest)
    ) {
      latest = event.sequence;
    }
  }
  return latest;
}

function replayBoundary(
  events: ReadonlyMap<number, AtomicFlowEvent>,
  selectedSequence: number | undefined,
  latestSequence: number,
): number {
  if (selectedSequence === undefined) {
    return 0;
  }

  let boundary = selectedSequence;
  for (const event of [...events.values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (event.sequence <= selectedSequence) {
      continue;
    }
    if (!isTraceObservationEvent(event)) {
      break;
    }
    boundary = event.sequence;
  }
  return Math.min(boundary, latestSequence);
}
