import type { ResearchReportValidation } from "@yiku/agent-research";
import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import type {
  AgentUsage,
  ConnectionStatus,
  FlowEdgeView,
  FlowNodeId,
  FlowNodeStatus,
  FlowNodeView,
  ResearchRunSnapshot,
  ResearchRunStatus,
  ResearchRunSummary,
  RunStreamEvent,
} from "../types.js";

export interface RunViewState {
  readonly connection: ConnectionStatus;
  readonly createdAt?: string | undefined;
  readonly error?: string | undefined;
  readonly events: ReadonlyMap<number, RunStreamEvent>;
  readonly model?: string | undefined;
  readonly output?: string | undefined;
  readonly prompt: string;
  readonly runId?: string | undefined;
  readonly status: ResearchRunStatus;
  readonly streamedText: string;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: ResearchReportValidation | undefined;
}

export type RunAction =
  | { readonly run: ResearchRunSummary; readonly type: "start" }
  | { readonly snapshot: ResearchRunSnapshot; readonly type: "load" }
  | { readonly event: RunStreamEvent; readonly type: "receive" }
  | { readonly connection: ConnectionStatus; readonly type: "connection" }
  | { readonly error: string; readonly type: "request_failed" }
  | { readonly type: "reset" };

export const INITIAL_RUN_STATE: RunViewState = {
  connection: "idle",
  events: new Map(),
  prompt: "",
  status: "idle",
  streamedText: "",
};

const FLOW_ORDER: readonly FlowNodeId[] = [
  "plan",
  "query",
  "search",
  "evidence-record",
  "corroborate",
  "synthesize",
  "citation-validate",
  "report",
];

export function runReducer(state: RunViewState, action: RunAction): RunViewState {
  switch (action.type) {
    case "start":
      return {
        connection: "connecting",
        createdAt: action.run.createdAt,
        events: new Map(),
        prompt: action.run.prompt,
        runId: action.run.runId,
        status: action.run.status,
        streamedText: "",
      };
    case "load": {
      const events = new Map(action.snapshot.events.map((event) => [event.id, event]));
      const rebuilt = rebuildRunState(
        {
          connection: state.connection,
          createdAt: action.snapshot.createdAt,
          events,
          prompt: action.snapshot.prompt,
          runId: action.snapshot.runId,
          status: action.snapshot.status,
          streamedText: "",
        },
        events,
      );
      return {
        ...rebuilt,
        ...(action.snapshot.error !== undefined ? { error: action.snapshot.error } : {}),
        ...(action.snapshot.model !== undefined ? { model: action.snapshot.model } : {}),
        ...(action.snapshot.output !== undefined ? { output: action.snapshot.output } : {}),
        streamedText:
          action.snapshot.streamedText.length > rebuilt.streamedText.length
            ? action.snapshot.streamedText
            : rebuilt.streamedText,
        ...(action.snapshot.usage !== undefined ? { usage: action.snapshot.usage } : {}),
        ...(action.snapshot.validation !== undefined
          ? { validation: action.snapshot.validation }
          : {}),
      };
    }
    case "receive": {
      if (state.runId !== action.event.runId) {
        return state;
      }
      const existing = state.events.get(action.event.id);
      if (existing !== undefined) {
        return state;
      }
      const events = new Map(state.events);
      events.set(action.event.id, action.event);
      return rebuildRunState(
        {
          connection: state.connection,
          ...(state.createdAt !== undefined ? { createdAt: state.createdAt } : {}),
          events,
          prompt: state.prompt,
          ...(state.runId !== undefined ? { runId: state.runId } : {}),
          status: state.runId === undefined ? "idle" : "queued",
          streamedText: "",
        },
        events,
      );
    }
    case "connection":
      return {
        ...state,
        connection: action.connection,
      };
    case "request_failed":
      return {
        ...state,
        error: action.error,
      };
    case "reset":
      return INITIAL_RUN_STATE;
  }
}

export function selectFlowNodes(state: RunViewState): readonly FlowNodeView[] {
  const statuses = new Map<FlowNodeId, FlowNodeStatus>(
    FLOW_ORDER.map((id) => [id, "idle"] as const),
  );
  let latestNodeId: FlowNodeId | undefined;

  for (const event of sortedEvents(state.events)) {
    if (event.type !== "flow") {
      continue;
    }

    const nodeId = mapAtomToNode(event.data.atom.key);
    if (nodeId === undefined) {
      continue;
    }
    latestNodeId = nodeId;
    statuses.set(nodeId, phaseStatus(event.data.phase));
  }

  return FLOW_ORDER.map((id) => ({
    executionActive: isRunActive(state.status) && id === latestNodeId,
    id,
    status: statuses.get(id) ?? "idle",
  }));
}

export function selectFlowEdges(state: RunViewState): readonly FlowEdgeView[] {
  const edgeByInstance = new Map<string, Omit<FlowEdgeView, "flowing" | "sequence" | "status">>();
  const edgeByRoute = new Map<string, FlowEdgeView>();
  let latestInstanceId: string | undefined;

  for (const event of sortedEvents(state.events)) {
    if (event.type !== "flow") {
      continue;
    }
    const instanceId = event.data.instance.id;
    if (mapAtomToNode(event.data.atom.key) !== undefined) {
      latestInstanceId = instanceId;
    }
    const eventEdge = event.data.edge;
    if (eventEdge !== undefined) {
      const from = mapAtomToNode(eventEdge.fromAtomKey);
      const to = mapAtomToNode(eventEdge.toAtomKey);
      if (from !== undefined && to !== undefined) {
        edgeByInstance.set(instanceId, {
          from,
          kind: eventEdge.kind,
          to,
        });
      }
    }
    const edge = edgeByInstance.get(instanceId);
    if (edge === undefined) {
      continue;
    }
    edgeByRoute.set(`${edge.from}:${edge.to}`, {
      ...edge,
      flowing: false,
      sequence: event.data.sequence,
      status:
        event.data.phase === "error"
          ? "failed"
          : event.data.phase === "end" || event.data.phase === "skipped"
            ? "completed"
            : "active",
    });
  }

  const flowingEdge =
    latestInstanceId === undefined ? undefined : edgeByInstance.get(latestInstanceId);
  return [...edgeByRoute.values()]
    .map((edge) => ({
      ...edge,
      flowing:
        isRunActive(state.status) && edge.from === flowingEdge?.from && edge.to === flowingEdge.to,
    }))
    .toSorted((left, right) => left.sequence - right.sequence);
}

export function selectTimelineEvents(state: RunViewState): readonly RunStreamEvent[] {
  return sortedEvents(state.events)
    .filter(
      (event) =>
        !(event.type === "progress" && event.data.type === "message_delta") &&
        !(event.type === "flow" && event.data.phase === "delta"),
    )
    .toReversed();
}

export function selectSearchCount(state: RunViewState): number {
  return sortedEvents(state.events).filter(
    (event) =>
      event.type === "flow" &&
      event.data.atom.key === "research.search" &&
      event.data.phase === "start",
  ).length;
}

function rebuildRunState(
  base: RunViewState,
  events: ReadonlyMap<number, RunStreamEvent>,
): RunViewState {
  let error: string | undefined;
  let model: string | undefined;
  let output: string | undefined;
  let status = base.status;
  let streamedText = "";
  let usage: AgentUsage | undefined;
  let validation: ResearchReportValidation | undefined;

  for (const event of sortedEvents(events)) {
    if (event.type === "progress") {
      if (event.data.type === "message_delta" && typeof event.data.text === "string") {
        streamedText += event.data.text;
      } else if (event.data.type === "usage_updated" && event.data.usage !== undefined) {
        usage = event.data.usage;
        model = event.data.model;
      }
    } else if (event.type === "status") {
      status = event.data.status;
      error = event.data.error ?? error;
      model = event.data.model ?? model;
      output = event.data.output ?? output;
      usage = event.data.usage ?? usage;
      validation = event.data.validation ?? validation;
    }
  }

  return {
    ...base,
    ...(error !== undefined ? { error } : {}),
    events,
    ...(model !== undefined ? { model } : {}),
    ...(output !== undefined ? { output } : {}),
    status,
    streamedText,
    ...(usage !== undefined ? { usage } : {}),
    ...(validation !== undefined ? { validation } : {}),
  };
}

function sortedEvents(events: ReadonlyMap<number, RunStreamEvent>): readonly RunStreamEvent[] {
  return [...events.values()].toSorted((left, right) => left.id - right.id);
}

function isRunActive(status: ResearchRunStatus): boolean {
  return status === "queued" || status === "running";
}

function phaseStatus(phase: AtomicFlowEvent["phase"]): FlowNodeStatus {
  if (phase === "start" || phase === "delta" || phase === "scheduled") {
    return "active";
  }
  return phase === "error" ? "failed" : "completed";
}

function mapAtomToNode(atomKey: string): FlowNodeId | undefined {
  switch (atomKey) {
    case "research.plan":
      return "plan";
    case "research.query":
      return "query";
    case "research.search":
      return "search";
    case "research.evidence-record":
      return "evidence-record";
    case "research.corroborate":
      return "corroborate";
    case "research.synthesize":
      return "synthesize";
    case "research.citation-validate":
      return "citation-validate";
    case "research.report":
      return "report";
    default:
      return undefined;
  }
}
