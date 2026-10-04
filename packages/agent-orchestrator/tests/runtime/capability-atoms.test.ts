import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import {
  AtomicRuntime,
  findRuntimeToolInstanceId,
  getSubagentExecutionInstanceId,
  recordRuntimeAtomicEvent,
} from "../../src/runtime/atomic-runtime.js";
import {
  CAPABILITY_ATOMS,
  RUNTIME_ATOM_DEFINITIONS,
  RUNTIME_ATOMS,
} from "../../src/runtime/atoms.js";

describe("Capability Atoms", () => {
  it("defines stable Skill and Agent lifecycle atoms without duplicate keys", () => {
    expect(CAPABILITY_ATOMS).toMatchObject({
      agentExecute: { key: "agent.execute", kind: "agent" },
      agentProfile: { key: "agent.profile", kind: "agent" },
      agentResult: { key: "agent.result", kind: "agent" },
      agentSpawn: { key: "agent.spawn", kind: "agent" },
      skillActivate: { key: "skill.activate", kind: "skill" },
      skillExecute: { key: "skill.execute", kind: "skill" },
      skillResolve: { key: "skill.resolve", kind: "skill" },
    });
    const keys = RUNTIME_ATOM_DEFINITIONS.map((atom) => atom.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("correlates Skill Worker and Subagent lifecycle spans", () => {
    const flow = new AtomicFlowRun({ runId: "capabilities" });
    recordRuntimeAtomicEvent(flow, {
      digest: "abc12345",
      name: "review",
      source: "project",
      type: "skill_resolved",
    });
    recordRuntimeAtomicEvent(flow, {
      name: "review",
      targetId: "agent-1",
      type: "skill_activated",
    });
    recordRuntimeAtomicEvent(flow, {
      name: "review",
      type: "skill_worker_started",
      workerId: "worker-1",
    });
    recordRuntimeAtomicEvent(flow, {
      name: "lint",
      status: "failed",
      type: "skill_worker_finished",
      workerId: "worker-without-start",
    });
    recordRuntimeAtomicEvent(flow, {
      action: "created",
      agentType: "code",
      profileId: "profile-1",
      type: "agent_profile_changed",
    });
    expect(getSubagentExecutionInstanceId(flow, "agent-1")).toBeUndefined();
    recordRuntimeAtomicEvent(flow, {
      name: "review",
      status: "succeeded",
      type: "skill_worker_finished",
      workerId: "worker-1",
    });
    recordRuntimeAtomicEvent(flow, {
      agentId: "agent-1",
      agentType: "code",
      profileId: "profile-1",
      taskId: "task-1",
      type: "subagent_spawned",
    });
    expect(getSubagentExecutionInstanceId(flow, "agent-1")).toBeDefined();
    recordRuntimeAtomicEvent(flow, {
      agentId: "agent-1",
      output: "review complete",
      profileId: "profile-1",
      taskId: "task-1",
      type: "subagent_output",
    });
    recordRuntimeAtomicEvent(flow, {
      agentId: "agent-1",
      profileId: "profile-1",
      status: "succeeded",
      taskId: "task-1",
      type: "subagent_result",
    });

    const events = flow.snapshot().events;
    const skill = events.filter((event) => event.atom.key === "skill.execute");
    const agent = events.filter((event) => event.atom.key === "agent.execute");
    const subagent = events.filter(
      (event) => event.atom.key === RUNTIME_ATOMS.subagentLifecycle.key,
    );
    expect(skill.map((event) => event.phase)).toEqual(["start", "start", "error", "end"]);
    expect(new Set(skill.map((event) => event.instance.id)).size).toBe(2);
    expect(
      events.find(
        (event) => event.atom.key === CAPABILITY_ATOMS.skillExecute.key && event.phase === "error",
      )?.payload?.code,
    ).toBe("SKILL_WORKER_FAILED");
    expect(events.some((event) => event.atom.key === CAPABILITY_ATOMS.agentProfile.key)).toBe(true);
    expect(agent.map((event) => event.phase)).toEqual(["start", "delta", "end"]);
    expect(agent[1]?.payload?.values?.output).toBe("review complete");
    expect(new Set(agent.map((event) => event.instance.id)).size).toBe(1);
    expect(subagent.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(new Set(subagent.map((event) => event.instance.id)).size).toBe(1);
    expect(
      events.find((event) => event.atom.key === CAPABILITY_ATOMS.agentSpawn.key)?.edge,
    ).toMatchObject({
      fromAtomKey: CAPABILITY_ATOMS.agentProfile.key,
      toAtomKey: CAPABILITY_ATOMS.agentSpawn.key,
    });
    expect(events.some((event) => event.atom.key === "agent.result")).toBe(true);
  });

  it("resolves Tool Call instance correlation by call ID", () => {
    const flow = new AtomicFlowRun({ runId: "tool-correlation" });
    flow
      .start({
        atom: RUNTIME_ATOMS.toolCall,
        instanceId: "tool-instance",
        payload: {
          values: {
            callId: "call-1",
          },
        },
      })
      .end();

    expect(findRuntimeToolInstanceId(flow, undefined)).toBeUndefined();
    expect(findRuntimeToolInstanceId(flow, "missing")).toBeUndefined();
    expect(findRuntimeToolInstanceId(flow, "call-1")).toBe("tool-instance");
  });

  it("records a Sandbox boundary change as a correlated Runtime atom", () => {
    const flow = new AtomicFlowRun({ runId: "runtime-boundary" });
    flow
      .start({
        atom: RUNTIME_ATOMS.toolCall,
        instanceId: "tool-instance",
      })
      .end();

    expect(
      recordRuntimeAtomicEvent(flow, {
        from: "sandbox",
        reason: "sandbox unavailable",
        to: "host-policy",
        type: "runtime_boundary_changed",
      }),
    ).toBe(true);
    expect(
      flow
        .snapshot()
        .events.find(
          (event) => event.atom.key === RUNTIME_ATOMS.runtimeBoundary.key && event.phase === "end",
        ),
    ).toMatchObject({
      edge: {
        fromAtomKey: RUNTIME_ATOMS.toolCall.key,
        toAtomKey: RUNTIME_ATOMS.runtimeBoundary.key,
      },
      payload: {
        code: "RUNTIME_BOUNDARY_CHANGED",
        values: {
          from: "sandbox",
          reason: "sandbox unavailable",
          to: "host-policy",
        },
      },
    });
  });

  it("captures complex Tool values without breaking the Flow", () => {
    const flow = new AtomicFlowRun({ runId: "complex-values" });
    const runtime = new AtomicRuntime(flow, "run-instance");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const anonymousFunction = () => undefined;
    Object.defineProperty(anonymousFunction, "name", { value: "" });
    const errorWithoutStack = new Error("without stack");
    errorWithoutStack.stack = undefined;
    const input = {
      anonymousFunction,
      bigint: 1n,
      circular,
      error: new Error("failed"),
      errorWithoutStack,
      fn: function namedFunction() {
        return undefined;
      },
      infinity: Number.POSITIVE_INFINITY,
      map: new Map([["key", "value"]]),
      set: new Set(["value"]),
      symbol: Symbol("value"),
      symbolWithoutDescription: Symbol(),
      undefined,
    };

    runtime.record({
      callId: "complex-call",
      input,
      summary: "complex input",
      title: "Complex",
      toolName: "complexTool",
      type: "tool_called",
    });
    runtime.record({
      callId: "complex-call",
      output: "x".repeat(40_000),
      summary: "complex output",
      title: "Complex",
      toolName: "complexTool",
      type: "tool_output",
    });
    runtime.record({
      callId: "throwing-call",
      input: {
        toJSON() {
          throw "cannot serialize";
        },
      },
      summary: "throwing input",
      title: "Throwing",
      toolName: "throwingTool",
      type: "tool_called",
    });
    runtime.record({
      callId: "throwing-error-call",
      input: {
        toJSON() {
          throw new Error("cannot serialize error");
        },
      },
      summary: "throwing error input",
      title: "Throwing Error",
      toolName: "throwingErrorTool",
      type: "tool_called",
    });
    runtime.record({
      callId: "function-call",
      input: anonymousFunction,
      summary: "function input",
      title: "Function",
      toolName: "functionTool",
      type: "tool_called",
    });
    const stringify = vi.spyOn(JSON, "stringify");
    stringify.mockReturnValueOnce(undefined);
    runtime.record({
      callId: "undefined-serialization-call",
      input: {},
      summary: "undefined serialization",
      title: "Undefined Serialization",
      toolName: "undefinedSerializationTool",
      type: "tool_called",
    });
    stringify.mockReturnValueOnce("not-json");
    runtime.record({
      callId: "invalid-json-call",
      input: {},
      summary: "invalid JSON",
      title: "Invalid JSON",
      toolName: "invalidJsonTool",
      type: "tool_called",
    });
    stringify.mockRestore();

    const events = flow.snapshot().events;
    const complex = events.find(
      (event) =>
        event.atom.key === RUNTIME_ATOMS.toolCall.key &&
        event.payload?.values?.callId === "complex-call",
    );
    expect(complex?.payload?.values?.input).toMatchObject({
      bigint: "1n",
      circular: { self: "[Circular]" },
      anonymousFunction: "[Function anonymous]",
      infinity: "[Infinity]",
      map: { key: "value" },
      set: ["value"],
      symbol: "[Symbol value]",
      symbolWithoutDescription: "[Symbol ]",
      undefined: "[undefined]",
    });
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.payload?.values?.callId === "throwing-call",
      )?.payload?.values?.input,
    ).toBe("[Unserializable: cannot serialize]");
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.payload?.values?.callId === "throwing-error-call",
      )?.payload?.values?.input,
    ).toBe("[Unserializable: cannot serialize error]");
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.payload?.values?.callId === "function-call",
      )?.payload?.values?.input,
    ).toBe("[Function anonymous]");
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.payload?.values?.callId === "undefined-serialization-call",
      )?.payload?.values?.input,
    ).toBe("[object]");
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.payload?.values?.callId === "invalid-json-call",
      )?.payload?.values?.input,
    ).toBe("not-json");
    expect(
      events.find(
        (event) =>
          event.atom.key === RUNTIME_ATOMS.toolCall.key &&
          event.phase === "end" &&
          event.payload?.values?.callId === "complex-call",
      )?.payload?.values?.output,
    ).toContain("[truncated after");
  });

  it.each(["cancelled", "failed"] as const)(
    "recovers missing Subagent spans for a %s result",
    (status) => {
      const flow = new AtomicFlowRun({ runId: `capabilities-${status}` });

      recordRuntimeAtomicEvent(flow, {
        agentId: `agent-${status}`,
        profileId: "reviewer",
        status,
        taskId: "task-1",
        type: "subagent_result",
      });

      const events = flow.snapshot().events;
      expect(
        events.find(
          (event) =>
            event.atom.key === CAPABILITY_ATOMS.agentExecute.key && event.phase === "error",
        )?.payload?.code,
      ).toBe(status === "cancelled" ? "SUBAGENT_CANCELLED" : "SUBAGENT_FAILED");
      expect(
        events.find(
          (event) =>
            event.atom.key === RUNTIME_ATOMS.subagentLifecycle.key && event.phase === "error",
        )?.payload?.code,
      ).toBe(status === "cancelled" ? "SUBAGENT_CANCELLED" : "SUBAGENT_FAILED");
    },
  );
});
