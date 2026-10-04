import type { RunSummary } from "../types.js";

export function automaticRunId(
  runs: readonly RunSummary[],
  selectedRunId: string | undefined,
  followLatest: boolean,
): string | undefined {
  const latestRunId = runs[0]?.runId;
  if (latestRunId === undefined) {
    return undefined;
  }
  if (selectedRunId === undefined || !runs.some((run) => run.runId === selectedRunId)) {
    return latestRunId;
  }
  return followLatest && selectedRunId !== latestRunId ? latestRunId : undefined;
}
