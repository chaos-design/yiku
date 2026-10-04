export interface RunDeepLink {
  readonly runId?: string | undefined;
  readonly view: "topology" | "trajectory";
}

export function parseRunDeepLink(search: string): RunDeepLink {
  const params = new URLSearchParams(search);
  const runIdValue = params.get("runId")?.trim();
  const runId =
    runIdValue !== undefined && runIdValue.length > 0 && runIdValue.length <= 128
      ? runIdValue
      : undefined;
  const view = params.get("view") === "trajectory" ? "trajectory" : "topology";
  return {
    ...(runId !== undefined ? { runId } : {}),
    view,
  };
}
