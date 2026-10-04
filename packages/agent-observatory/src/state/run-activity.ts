import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import type { RunStatus } from "../types.js";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["evaluating", "queued", "running"]);
const TERMINAL_PHASES = new Set<AtomicFlowEvent["phase"]>(["end", "error", "skipped"]);
const ACTIVE_TRACE_ATOM_KEYS = ["trace.append", "trajectory.project"] as const;

export function isActiveRunStatus(status: RunStatus | undefined): boolean {
  return status !== undefined && ACTIVE_RUN_STATUSES.has(status);
}

export function activeObservedAtomKeys(
  observed: ReadonlySet<string>,
  active: boolean,
): ReadonlySet<string> {
  return active ? new Set([...observed, ...ACTIVE_TRACE_ATOM_KEYS]) : new Set();
}

export function shouldHighlightExecution(
  status: RunStatus | undefined,
  event: AtomicFlowEvent | undefined,
  live: boolean,
): boolean {
  if (event === undefined) {
    return false;
  }
  if (!live) {
    return true;
  }
  if (!isActiveRunStatus(status)) {
    return false;
  }
  if (
    TERMINAL_PHASES.has(event.phase) &&
    (event.atom.key === "run" || event.atom.key === "eval.gate")
  ) {
    return false;
  }
  return true;
}
