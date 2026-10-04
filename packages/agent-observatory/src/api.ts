import type { RunDetail, RunSummary } from "./types.js";

export async function announceBrowserPresence(): Promise<void> {
  await request("/api/browser-presence", { method: "POST" });
}

export async function listRuns(): Promise<readonly RunSummary[]> {
  return request<readonly RunSummary[]>("/api/runs");
}

export async function getRun(runId: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = (await response.json()) as T | { readonly message?: string };
  if (!response.ok) {
    throw new Error(
      "message" in (value as object)
        ? (value as { message?: string }).message
        : `Request failed: ${response.status}`,
    );
  }
  return value as T;
}
