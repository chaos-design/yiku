import type {
  ObservatoryStatus,
  ResearchRunSnapshot,
  ResearchRunSummary,
  ResearchSkillId,
  ResearchThreadSnapshot,
  ResearchThreadSummary,
  ResearchTurnOptions,
  ResearchTurnSnapshot,
  ResearchTurnSummary,
  RunStreamEvent,
} from "./types.js";

export function getObservatoryStatus(): Promise<ObservatoryStatus> {
  return request<ObservatoryStatus>("/api/observatory");
}

export function listThreads(): Promise<readonly ResearchThreadSummary[]> {
  return request<readonly ResearchThreadSummary[]>("/api/threads");
}

export function createThread(title?: string): Promise<ResearchThreadSummary> {
  return request<ResearchThreadSummary>("/api/threads", {
    body: JSON.stringify(title === undefined ? {} : { title }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export function getThread(threadId: string): Promise<ResearchThreadSnapshot> {
  return request<ResearchThreadSnapshot>(`/api/threads/${encodeURIComponent(threadId)}`);
}

export async function deleteThread(threadId: string): Promise<void> {
  await request(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
  });
}

export function createTurn(
  threadId: string,
  prompt: string,
  skill: ResearchSkillId,
  options: ResearchTurnOptions = {},
): Promise<ResearchTurnSummary> {
  return request<ResearchTurnSummary>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    body: JSON.stringify({ ...options, prompt, skill }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export function getTurn(turnId: string): Promise<ResearchTurnSnapshot> {
  return request<ResearchTurnSnapshot>(`/api/turns/${encodeURIComponent(turnId)}`);
}

export async function cancelTurn(turnId: string): Promise<void> {
  await request(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
  });
}

export async function createRun(prompt: string): Promise<ResearchRunSummary> {
  return request<ResearchRunSummary>("/api/runs", {
    body: JSON.stringify({ prompt }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export async function getRun(runId: string): Promise<ResearchRunSnapshot> {
  return request<ResearchRunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function cancelRun(runId: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}

export interface RunEventSubscription {
  readonly afterId?: number | undefined;
  readonly onConnectionChange: (status: "disconnected" | "live") => void;
  readonly onError: (error: Error) => void;
  readonly onEvent: (event: RunStreamEvent) => void;
  readonly runId: string;
}

export function subscribeRunEvents(options: RunEventSubscription): () => void {
  return subscribeEvents(
    `/api/runs/${encodeURIComponent(options.runId)}/events`,
    options.afterId,
    options,
  );
}

export interface TurnEventSubscription {
  readonly afterId?: number | undefined;
  readonly onConnectionChange: (status: "disconnected" | "live") => void;
  readonly onError: (error: Error) => void;
  readonly onEvent: (event: RunStreamEvent) => void;
  readonly turnId: string;
}

export function subscribeTurnEvents(options: TurnEventSubscription): () => void {
  return subscribeEvents(
    `/api/turns/${encodeURIComponent(options.turnId)}/events`,
    options.afterId,
    options,
  );
}

function subscribeEvents(
  path: string,
  afterId: number | undefined,
  options: Pick<RunEventSubscription, "onConnectionChange" | "onError" | "onEvent">,
): () => void {
  const after = afterId ?? 0;
  const source = new EventSource(`${path}?after=${after}`);
  let closed = false;

  source.onopen = () => {
    options.onConnectionChange("live");
  };
  source.onerror = () => {
    if (!closed) {
      options.onConnectionChange("disconnected");
    }
  };
  source.addEventListener("run-event", (message) => {
    try {
      const event = JSON.parse((message as MessageEvent<string>).data) as RunStreamEvent;
      options.onEvent(event);
      if (event.type === "status" && isTerminal(event.data.status)) {
        closed = true;
        source.close();
      }
    } catch (error) {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return () => {
    closed = true;
    source.close();
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = (await response.json()) as T | { readonly message?: string };

  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string"
        ? value.message
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return value as T;
}

function isTerminal(status: string): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}
