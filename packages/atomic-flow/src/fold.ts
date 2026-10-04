import { AtomicFlowError } from "./errors.js";
import type {
  AtomicEdge,
  AtomicFlowEvent,
  AtomicFoldState,
  AtomicInstanceState,
  AtomicStatus,
} from "./types.js";

export function foldAtomicEvents(
  events: readonly AtomicFlowEvent[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): AtomicFoldState {
  const instances = new Map<string, AtomicInstanceState>();
  const edges = new Map<string, AtomicEdge>();
  let latestSequence = 0;
  let runId: string | undefined;

  for (const event of events) {
    if (event.sequence > throughSequence) {
      break;
    }

    if (event.sequence <= latestSequence) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_INVALID_EVENT",
        "Atomic events must have strictly increasing sequences.",
      );
    }

    if (runId !== undefined && runId !== event.runId) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_INVALID_EVENT",
        "Atomic events from different runs cannot be folded together.",
      );
    }

    runId = event.runId;
    latestSequence = event.sequence;
    const previous = instances.get(event.instance.id);
    const status = statusForPhase(event.phase, previous?.status);
    instances.set(event.instance.id, {
      atom: event.atom,
      ...(event.phase === "end" || event.phase === "error" || event.phase === "skipped"
        ? { endedAt: event.occurredAt }
        : {}),
      ...(event.phase === "error" && event.payload?.code !== undefined
        ? { errorCode: event.payload.code }
        : {}),
      id: event.instance.id,
      ...(event.instance.iteration !== undefined ? { iteration: event.instance.iteration } : {}),
      lastSequence: event.sequence,
      ...(event.instance.parentId !== undefined ? { parentId: event.instance.parentId } : {}),
      ...(previous?.startedAt !== undefined
        ? { startedAt: previous.startedAt }
        : event.phase === "start"
          ? { startedAt: event.occurredAt }
          : {}),
      status,
    });

    if (event.edge !== undefined) {
      edges.set(
        `${event.edge.fromInstanceId ?? event.edge.fromAtomKey}:${event.edge.toAtomKey}:${event.edge.kind}`,
        event.edge,
      );
    }
  }

  return {
    edges,
    instances,
    latestSequence,
    ...(runId !== undefined ? { runId } : {}),
  };
}

function statusForPhase(phase: AtomicFlowEvent["phase"], previous?: AtomicStatus): AtomicStatus {
  switch (phase) {
    case "scheduled":
      return "scheduled";
    case "start":
    case "delta":
      return "running";
    case "end":
      return "completed";
    case "error":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return previous ?? "scheduled";
  }
}
