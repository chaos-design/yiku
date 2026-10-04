import { Agent } from "@openai/agents";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import {
  registerAgentFactoryResult,
  registerAgentGraph,
} from "../../src/agents/agent-runtime-metadata.js";
import { createAgentGraphRunObserver } from "../../src/agents/run-observer.js";
import type { AgentRunObserver } from "../../src/agents/types.js";

describe("AgentGraphRunObserver", () => {
  it("starts lazily, routes by Agent ID, and finishes every started observer", async () => {
    const root = createAgent("Same Name");
    const handoff = createAgent("Same Name");
    const rootObserver = observer();
    const handoffObserver = observer({
      output: vi.fn(() => ({
        diagnostics: [],
        passed: true,
      })),
    });
    registerAgentFactoryResult(
      {
        agent: root,
        createRunObserver: () => rootObserver,
      },
      { agentId: "root", agentType: "code" },
    );
    registerAgentFactoryResult(
      {
        agent: handoff,
        createRunObserver: () => handoffObserver,
      },
      { agentId: "research", agentType: "research" },
    );
    registerAgentGraph(root, [handoff]);
    const flow = new AtomicFlowRun({ runId: "observer-routing" });
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Research",
      runId: flow.runId,
    });

    runObserver.start();
    runObserver.progress({ text: "root", type: "message_delta" });
    runObserver.progress({
      agentId: "research",
      agentName: "Same Name",
      type: "agent_updated",
    });
    runObserver.progress({ text: "handoff", type: "message_delta" });

    await expect(runObserver.output("done")).resolves.toEqual({
      diagnostics: [],
      passed: true,
    });
    runObserver.stop("completed");
    await runObserver.close();
    await runObserver.close();

    expect(rootObserver.start).toHaveBeenCalledOnce();
    expect(rootObserver.progress).toHaveBeenCalledWith({
      text: "root",
      type: "message_delta",
    });
    expect(handoffObserver.start).toHaveBeenCalledOnce();
    expect(handoffObserver.progress).toHaveBeenCalledTimes(2);
    expect(handoffObserver.output).toHaveBeenCalledWith("done");
    expect(rootObserver.stop).toHaveBeenCalledWith("completed");
    expect(handoffObserver.stop).toHaveBeenCalledWith("completed");
    expect(rootObserver.close).toHaveBeenCalledOnce();
    expect(handoffObserver.close).toHaveBeenCalledOnce();
  });

  it("degrades once without skipping output validation", async () => {
    const root = createAgent("Root");
    const rootObserver = observer({
      close: vi.fn(() => {
        throw new Error("close failed");
      }),
      output: vi.fn(() => ({
        diagnostics: ["invalid"],
        passed: false,
      })),
      progress: vi.fn(() => {
        throw new Error("progress failed");
      }),
    });
    registerAgentFactoryResult(
      {
        agent: root,
        createRunObserver: () => rootObserver,
      },
      { agentId: "root", agentType: "code" },
    );
    const flow = new AtomicFlowRun({ runId: "observer-degraded" });
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Inspect",
      runId: flow.runId,
    });

    runObserver.start();
    runObserver.progress({ type: "reasoning" });
    runObserver.progress({ text: "ignored", type: "message_delta" });
    await expect(runObserver.output("draft")).resolves.toEqual({
      diagnostics: ["invalid"],
      passed: false,
    });
    await runObserver.close();

    expect(rootObserver.progress).toHaveBeenCalledOnce();
    expect(rootObserver.output).toHaveBeenCalledOnce();
    expect(
      flow.snapshot().events.filter((event) => event.atom.key === "observability.degraded"),
    ).toEqual([
      expect.objectContaining({
        internal: true,
        payload: expect.objectContaining({
          code: "AGENT_OBSERVER_FAILED",
          values: expect.objectContaining({
            agentId: "root",
            operation: "progress",
          }),
        }),
        phase: "error",
      }),
    ]);
  });

  it("falls back to the registered output validator", async () => {
    const root = createAgent("Validator");
    const validateOutput = vi.fn(async () => ({
      diagnostics: [],
      passed: true,
    }));
    registerAgentFactoryResult(
      {
        agent: root,
        validateOutput,
      },
      { agentId: "validator", agentType: "custom" },
    );
    const flow = new AtomicFlowRun({ runId: "observer-validator" });
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Validate",
      runId: flow.runId,
    });

    await expect(runObserver.output("output")).resolves.toEqual({
      diagnostics: [],
      passed: true,
    });
    await expect(runObserver.output("ignored")).resolves.toBeUndefined();
    expect(validateOutput).toHaveBeenCalledOnce();
  });

  it("handles unknown handoffs, duplicate terminal calls, and close failures", async () => {
    const root = createAgent("Root");
    const rootObserver = observer({
      close: vi.fn(() => {
        throw "close failed";
      }),
      error: vi.fn(() => {
        throw new Error("error callback failed");
      }),
    });
    registerAgentFactoryResult(
      {
        agent: root,
        createRunObserver: () => rootObserver,
      },
      { agentId: "root", agentType: "code" },
    );
    const flow = new AtomicFlowRun({ runId: "observer-terminal" });
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Inspect",
      runId: flow.runId,
    });
    runObserver.start();
    runObserver.progress({
      agentId: "missing",
      agentName: "Unknown",
      type: "agent_updated",
    });
    runObserver.error("failed");
    runObserver.error("ignored");
    await runObserver.close();
    runObserver.progress({ type: "reasoning" });

    expect(rootObserver.progress).toHaveBeenCalledOnce();
    expect(rootObserver.error).toHaveBeenCalledOnce();
    expect(
      flow.snapshot().events.filter((event) => event.atom.key === "observability.degraded"),
    ).toHaveLength(1);
  });

  it("degrades Observer construction and rejects duplicate runtime IDs", async () => {
    const root = createAgent("Root");
    const duplicate = createAgent("Duplicate");
    const validateOutput = vi.fn(() => ({
      diagnostics: [],
      passed: true,
    }));
    registerAgentFactoryResult(
      {
        agent: root,
        createRunObserver: () => {
          throw new Error("factory failed");
        },
        validateOutput,
      },
      { agentId: "same", agentType: "code" },
    );
    registerAgentFactoryResult({ agent: duplicate }, { agentId: "same", agentType: "research" });
    registerAgentGraph(root, [duplicate]);
    const flow = new AtomicFlowRun({ runId: "observer-duplicate" });

    expect(() =>
      createAgentGraphRunObserver(root, {
        atomicFlow: flow,
        parentInstanceId: "run",
        prompt: "Inspect",
        runId: flow.runId,
      }),
    ).toThrow("Duplicate Agent runtime ID");

    registerAgentGraph(root, [root]);
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Inspect",
      runId: flow.runId,
    });
    runObserver.start();
    await expect(runObserver.output("result")).resolves.toEqual({
      diagnostics: [],
      passed: true,
    });
    expect(validateOutput).toHaveBeenCalledOnce();
    expect(
      flow.snapshot().events.find((event) => event.atom.key === "observability.degraded")?.payload
        ?.values,
    ).toMatchObject({
      operation: "start",
    });
  });

  it("is inert for an unregistered root Agent", async () => {
    const root = createAgent("Unregistered");
    const flow = new AtomicFlowRun({ runId: "observer-empty" });
    const runObserver = createAgentGraphRunObserver(root, {
      atomicFlow: flow,
      parentInstanceId: "run",
      prompt: "Inspect",
      runId: flow.runId,
    });

    runObserver.start();
    runObserver.progress({ type: "reasoning" });
    await expect(runObserver.output("result")).resolves.toBeUndefined();
    runObserver.stop("cancelled");
    await runObserver.close();
  });
});

function observer(overrides: Partial<AgentRunObserver> = {}): AgentRunObserver {
  return {
    close: vi.fn(),
    error: vi.fn(),
    output: vi.fn(),
    progress: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

function createAgent(name: string): Agent {
  return new Agent({
    instructions: "Test.",
    model: "gpt-test",
    name,
  });
}
