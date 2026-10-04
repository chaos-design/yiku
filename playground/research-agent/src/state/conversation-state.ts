import type {
  ConnectionStatus,
  ResearchThreadSnapshot,
  ResearchThreadSummary,
  ResearchTurnSnapshot,
  ResearchTurnSummary,
  RunStreamEvent,
} from "../types.js";

export interface ConversationState {
  readonly connection: ConnectionStatus;
  readonly error: string | undefined;
  readonly selectedThread: ResearchThreadSnapshot | undefined;
  readonly selectedTurn: ResearchTurnSnapshot | undefined;
  readonly threads: readonly ResearchThreadSummary[];
}

export type ConversationAction =
  | { readonly threads: readonly ResearchThreadSummary[]; readonly type: "threads_loaded" }
  | { readonly thread: ResearchThreadSummary; readonly type: "thread_created" }
  | { readonly thread: ResearchThreadSnapshot; readonly type: "thread_selected" }
  | { readonly threadId: string; readonly type: "thread_deleted" }
  | { readonly turn: ResearchTurnSummary; readonly type: "turn_started" }
  | { readonly event: RunStreamEvent; readonly type: "event_received" }
  | { readonly snapshot: ResearchTurnSnapshot; readonly type: "turn_loaded" }
  | { readonly connection: ConnectionStatus; readonly type: "connection_changed" }
  | { readonly error: string; readonly type: "request_failed" }
  | { readonly type: "clear_error" };

export const INITIAL_CONVERSATION_STATE: ConversationState = {
  connection: "idle",
  error: undefined,
  selectedThread: undefined,
  selectedTurn: undefined,
  threads: [],
};

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "threads_loaded":
      return {
        ...state,
        threads: [...action.threads],
      };
    case "thread_created":
      return {
        ...state,
        error: undefined,
        selectedThread: {
          ...action.thread,
          messages: [],
          turns: [],
        },
        selectedTurn: undefined,
        threads: upsertThread(state.threads, action.thread),
      };
    case "thread_selected":
      return {
        ...state,
        error: undefined,
        selectedThread: action.thread,
        selectedTurn: action.thread.turns.at(-1),
        threads: upsertThread(state.threads, action.thread),
      };
    case "thread_deleted": {
      const selected = state.selectedThread?.threadId === action.threadId;
      return {
        ...state,
        connection: selected ? "idle" : state.connection,
        error: undefined,
        selectedThread: selected ? undefined : state.selectedThread,
        selectedTurn: selected ? undefined : state.selectedTurn,
        threads: state.threads.filter((thread) => thread.threadId !== action.threadId),
      };
    }
    case "turn_started": {
      const turn: ResearchTurnSnapshot = {
        ...action.turn,
        events: [],
        evidence: [],
        streamedText: "",
      };
      const selectedThread =
        state.selectedThread?.threadId === action.turn.threadId
          ? {
              ...state.selectedThread,
              status: action.turn.status,
              turns: [...state.selectedThread.turns, turn],
              updatedAt: action.turn.updatedAt,
            }
          : state.selectedThread;
      return {
        ...state,
        connection: "connecting",
        error: undefined,
        selectedThread,
        selectedTurn: turn,
        threads:
          selectedThread === undefined
            ? state.threads
            : upsertThread(state.threads, selectedThread),
      };
    }
    case "event_received": {
      const selectedTurn = state.selectedTurn;
      if (selectedTurn === undefined || selectedTurn.turnId !== action.event.runId) {
        return state;
      }
      if (selectedTurn.events.some((event) => event.id === action.event.id)) {
        return state;
      }
      return {
        ...state,
        selectedTurn: rebuildTurn({
          ...selectedTurn,
          events: [...selectedTurn.events, action.event],
        }),
      };
    }
    case "turn_loaded":
      return {
        ...state,
        selectedTurn: action.snapshot,
      };
    case "connection_changed":
      return {
        ...state,
        connection: action.connection,
      };
    case "request_failed":
      return {
        ...state,
        error: action.error,
      };
    case "clear_error":
      return {
        ...state,
        error: undefined,
      };
  }
}

export function activeTurn(state: ConversationState): ResearchTurnSnapshot | undefined {
  const turn = state.selectedTurn;
  return turn?.status === "queued" || turn?.status === "running" ? turn : undefined;
}

function rebuildTurn(turn: ResearchTurnSnapshot): ResearchTurnSnapshot {
  let error = turn.error;
  let model = turn.model;
  let output = turn.output;
  let status = turn.status;
  let streamedText = "";
  let usage = turn.usage;
  let validation = turn.validation;

  for (const event of [...turn.events].toSorted((left, right) => left.id - right.id)) {
    if (event.type === "progress") {
      if (event.data.type === "message_delta" && typeof event.data.text === "string") {
        streamedText += event.data.text;
      } else if (event.data.type === "usage_updated") {
        model = event.data.model ?? model;
        usage = event.data.usage ?? usage;
      }
    } else if (event.type === "status") {
      error = event.data.error ?? error;
      model = event.data.model ?? model;
      output = event.data.output ?? output;
      status = event.data.status;
      usage = event.data.usage ?? usage;
      validation = event.data.validation ?? validation;
    }
  }

  return {
    ...turn,
    ...(error !== undefined ? { error } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(output !== undefined ? { output } : {}),
    status,
    streamedText: streamedText || turn.streamedText,
    ...(usage !== undefined ? { usage } : {}),
    ...(validation !== undefined ? { validation } : {}),
  };
}

function upsertThread(
  threads: readonly ResearchThreadSummary[],
  thread: ResearchThreadSummary,
): readonly ResearchThreadSummary[] {
  return [
    thread,
    ...threads.filter((candidate) => candidate.threadId !== thread.threadId),
  ].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
