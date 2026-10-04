import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import {
  activeObservedAtomKeys,
  isActiveRunStatus,
  shouldHighlightExecution,
} from "../../src/state/run-activity.js";

describe("isActiveRunStatus", () => {
  it("allows flow animation only for active run statuses", () => {
    expect(["queued", "running", "evaluating"].every(isActiveRunStatus)).toBe(true);
    expect(
      ["accepted", "completed", "failed", "rejected", "cancelled", "degraded"].some(
        isActiveRunStatus,
      ),
    ).toBe(false);
    expect(isActiveRunStatus(undefined)).toBe(false);
  });

  it("ends automatic highlighting at terminal flow boundaries", () => {
    expect(shouldHighlightExecution("running", atomicEvent("tool.call", "end"), true)).toBe(true);
    expect(shouldHighlightExecution("running", atomicEvent("run", "end"), true)).toBe(false);
    expect(shouldHighlightExecution("evaluating", atomicEvent("eval.gate", "end"), true)).toBe(
      false,
    );
    expect(shouldHighlightExecution("completed", atomicEvent("tool.call", "end"), true)).toBe(
      false,
    );
    expect(
      shouldHighlightExecution("failed", atomicEvent("eval.flow-integrity", "error"), true),
    ).toBe(false);
  });

  it("keeps manual replay selectable and disables live highlighting after completion", () => {
    expect(shouldHighlightExecution("completed", atomicEvent("tool.call", "end"), false)).toBe(
      true,
    );
    expect(
      shouldHighlightExecution("completed", atomicEvent("eval.flow-integrity", "start"), true),
    ).toBe(false);
  });

  it("keeps Trace Append and Trajectory Project observed only during active execution", () => {
    expect([...activeObservedAtomKeys(new Set(["custom"]), true)].toSorted()).toEqual([
      "custom",
      "trace.append",
      "trajectory.project",
    ]);
    expect([...activeObservedAtomKeys(new Set(["custom"]), false)]).toEqual([]);
  });
});

function atomicEvent(atomKey: string, phase: AtomicFlowEvent["phase"]): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind: atomKey.startsWith("eval.") ? "eval" : "tool",
      label: atomKey,
      level: "runtime",
    },
    eventId: `${atomKey}-${phase}`,
    instance: {
      id: `${atomKey}-instance`,
    },
    occurredAt: "2026-08-05T00:00:00.000Z",
    phase,
    runId: "run-1",
    sequence: 1,
  };
}
