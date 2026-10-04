import { AtomicFlowRun } from "@yiku/atomic-flow";
import { TrajectoryRecorder } from "@yiku/trajectory";
import { describe, expect, it, vi } from "vitest";
import { HookAudit } from "../../src/hooks/audit.js";

describe("HookAudit", () => {
  it("stores bounded sanitized events and forwards them to a sink", () => {
    const sink = vi.fn();
    const audit = new HookAudit({ maxEntries: 2, sink });

    audit.handle(event("operation-1"));
    audit.handle(event("operation-2"));
    audit.handle(event("operation-3"));

    expect(audit.recent()).toEqual([event("operation-2"), event("operation-3")]);
    expect(sink).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(audit.recent())).not.toContain("prompt");
  });

  it("supports bounded reads, clearing, and limit validation", () => {
    const audit = new HookAudit({ maxEntries: 2 });
    audit.handle(event("operation-1"));
    audit.handle(event("operation-2"));

    expect(audit.recent(1)).toEqual([event("operation-2")]);
    expect(audit.recent(-1)).toEqual([]);
    audit.clear();
    expect(audit.recent()).toEqual([]);
    expect(() => new HookAudit({ maxEntries: 0 })).toThrow("positive safe integer");
  });

  it("maps sanitized Hook spans into Atomic Flow and Trajectory", () => {
    const atomicFlow = new AtomicFlowRun({ runId: "run-1" });
    const trajectory = new TrajectoryRecorder("run-1");
    const audit = new HookAudit({
      atomicFlow,
      parentInstanceId: "run-instance",
      trajectory,
    });

    audit.handle(event("hook-operation"));
    audit.handle({
      ...event("hook-operation"),
      durationMs: 12,
      endedAt: "2026-08-01T00:00:00.012Z",
      outcome: "success",
      phase: "end",
      truncatedBytes: 8,
    });

    expect(
      atomicFlow
        .snapshot()
        .events.filter((item) => item.atom.kind === "hook")
        .map((item) => item.phase),
    ).toEqual(["start", "end"]);
    expect(trajectory.snapshot().steps).toEqual([
      expect.objectContaining({
        id: "hook-operation",
        kind: "hook",
        parentId: "run-instance",
        status: "completed",
      }),
    ]);
    const serialized = JSON.stringify({
      atomic: atomicFlow.snapshot(),
      trajectory: trajectory.snapshot(),
    });
    expect(serialized).toContain('"truncatedBytes":8');
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("environment");
  });

  it("handles duplicate starts, orphan completions, and full error metadata", () => {
    const atomicFlow = new AtomicFlowRun({ runId: "run-errors" });
    const trajectory = new TrajectoryRecorder("run-errors");
    const audit = new HookAudit({ atomicFlow, trajectory });
    const fullEvent = {
      code: "HOOK_TIMEOUT",
      counts: { attempts: 1 },
      durationMs: 10,
      endedAt: "2026-08-01T00:00:00.010Z",
      eventName: "PreToolUse" as const,
      executorType: "command" as const,
      hookId: "hook-full",
      invocationId: "invocation-full",
      operation: "execute" as const,
      operationId: "full",
      outcome: "timeout" as const,
      parentInvocationId: "parent-hook",
      phase: "start" as const,
      sourceType: "project" as const,
      startedAt: "2026-08-01T00:00:00.000Z",
      truncatedBytes: 12,
    };

    audit.handle(fullEvent);
    audit.handle(fullEvent);
    audit.handle({ ...fullEvent, phase: "error" });
    audit.handle({
      operation: "dispatch",
      operationId: "orphan",
      phase: "end",
      startedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(
      atomicFlow
        .snapshot()
        .events.filter((item) => item.atom.kind === "hook")
        .map((item) => [item.instance.id, item.phase]),
    ).toEqual([
      ["full", "start"],
      ["full", "error"],
      ["orphan", "start"],
      ["orphan", "end"],
    ]);
    expect(trajectory.snapshot().steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "HOOK_TIMEOUT",
          id: "full",
          parentId: "parent-hook",
          status: "failed",
        }),
        expect.objectContaining({
          id: "orphan",
          name: "hook.dispatch",
          status: "completed",
        }),
      ]),
    );
  });
});

function event(operationId: string) {
  return {
    eventName: "Stop" as const,
    executorType: "command" as const,
    hookId: "hook-1",
    operation: "execute" as const,
    operationId,
    phase: "start" as const,
    sourceType: "project" as const,
    startedAt: "2026-08-01T00:00:00.000Z",
  };
}
