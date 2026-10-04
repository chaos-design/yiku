import { describe, expect, it, vi } from "vitest";
import { AgentManagementService } from "../../src/agents/agent-management-service.js";
import type {
  SessionSubagentInstance,
  SessionSubagentProfile,
} from "../../src/session/session-state.js";

describe("AgentManagementService", () => {
  it("uses the Broker and Registry as the only profile state boundaries", async () => {
    const profile = subagentProfile();
    const broker = {
      create: vi.fn(async () => profile),
    };
    const registry = registryFixture(profile);
    const service = new AgentManagementService({
      broker,
      registry,
      run: async () => ({ finalOutput: "done" }),
    });

    await expect(service.create({ intent: "review" }, { createdBy: "user" })).resolves.toEqual(
      profile,
    );
    await expect(service.list()).resolves.toEqual([profile]);
    await expect(service.show(profile.id)).resolves.toEqual(profile);
    await expect(service.remove(profile.id)).resolves.toBeUndefined();
    expect(registry.remove).toHaveBeenCalledWith(profile.id);
  });

  it("runs a profile and returns a structured result after closing the instance", async () => {
    const profile = subagentProfile();
    const registry = registryFixture(profile);
    const run = vi.fn(async () => ({
      finalOutput: "review complete",
      usage: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens: 4,
        peakInputTokens: 10,
        totalTokens: 14,
      },
    }));
    const service = new AgentManagementService({
      broker: { create: vi.fn() },
      registry,
      run,
    });

    await expect(service.run(profile.id, "inspect auth")).resolves.toMatchObject({
      agentId: "agent-1",
      finalOutput: "review complete",
      profileId: profile.id,
      status: "succeeded",
      taskId: "task-1",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        prompt: "inspect auth",
      }),
    );
    expect(registry.finishInstance).toHaveBeenCalledWith("agent-1", "succeeded");
  });

  it("records failed and cancelled instance outcomes before rethrowing", async () => {
    const profile = subagentProfile();
    const failedRegistry = registryFixture(profile);
    const failed = new AgentManagementService({
      broker: { create: vi.fn() },
      registry: failedRegistry,
      run: async () => {
        throw new Error("provider failed");
      },
    });

    await expect(failed.run(profile.id, "run")).rejects.toThrow("provider failed");
    expect(failedRegistry.finishInstance).toHaveBeenCalledWith(
      "agent-1",
      "failed",
      "provider failed",
    );

    const cancelledRegistry = registryFixture(profile);
    const controller = new AbortController();
    const onEvent = vi.fn();
    const cancelled = new AgentManagementService({
      broker: { create: vi.fn() },
      onEvent,
      registry: cancelledRegistry,
      run: async () => {
        controller.abort(new Error("cancelled"));
        throw new Error("cancelled");
      },
    });
    await expect(cancelled.run(profile.id, "run", { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(cancelledRegistry.finishInstance).toHaveBeenCalledWith(
      "agent-1",
      "cancelled",
      "cancelled",
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "cancelled", type: "subagent_result" }),
    );
  });

  it("emits lifecycle events and preserves optional validation and signals", async () => {
    const profile = subagentProfile();
    const registry = registryFixture(profile);
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    const service = new AgentManagementService({
      broker: { create: vi.fn(async () => profile) },
      onEvent,
      parentAgentId: "root",
      parentSessionId: "session-1",
      registry,
      run: vi.fn(async (input) => {
        expect(input.parentToolCallId).toBe("agent-run-1");
        expect(input.signal).toBe(signal);
        return {
          finalOutput: "validated",
          validation: { diagnostics: [], passed: true },
        };
      }),
      taskIdGenerator: () => "generated-task",
    });

    await service.create({}, { createdBy: "agent" });
    await service.remove(profile.id);
    await expect(
      service.run(profile.id, "  inspect  ", {
        parentToolCallId: "agent-run-1",
        signal,
      }),
    ).resolves.toMatchObject({
      finalOutput: "validated",
      validation: { diagnostics: [], passed: true },
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "agent_profile_changed",
      "agent_profile_changed",
      "subagent_spawned",
      "subagent_output",
      "subagent_result",
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: profile.name,
        output: "validated",
        type: "subagent_output",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: profile.name,
        parentAgentId: "root",
        parentSessionId: "session-1",
        parentToolCallId: "agent-run-1",
        prompt: "inspect",
        type: "subagent_spawned",
      }),
    );
  });

  it("rejects missing profiles, blank prompts, and pre-aborted runs", async () => {
    const profile = subagentProfile();
    const missingRegistry = registryFixture(profile);
    missingRegistry.get.mockResolvedValueOnce(undefined);
    const service = new AgentManagementService({
      broker: { create: vi.fn() },
      registry: missingRegistry,
      run: vi.fn(),
    });

    await expect(service.show("missing")).rejects.toThrow("Subagent Profile not found");
    await expect(service.run(profile.id, "   ")).rejects.toThrow(
      "Subagent task prompt must be non-empty",
    );

    const controller = new AbortController();
    controller.abort("stopped");
    await expect(service.run(profile.id, "run", { signal: controller.signal })).rejects.toThrow(
      "Subagent run was cancelled",
    );
    const errorController = new AbortController();
    errorController.abort(new Error("explicit cancellation"));
    await expect(
      service.run(profile.id, "run", { signal: errorController.signal }),
    ).rejects.toThrow("explicit cancellation");
    expect(missingRegistry.startInstance).not.toHaveBeenCalled();
  });

  it("normalizes non-Error failures before closing an instance", async () => {
    const profile = subagentProfile();
    const registry = registryFixture(profile);
    const onEvent = vi.fn();
    const service = new AgentManagementService({
      broker: { create: vi.fn() },
      onEvent,
      registry,
      run: async () => Promise.reject("provider unavailable"),
    });

    await expect(service.run(profile.id, "run")).rejects.toBe("provider unavailable");
    expect(registry.finishInstance).toHaveBeenCalledWith(
      "agent-1",
      "failed",
      "provider unavailable",
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", type: "subagent_result" }),
    );
  });
});

function registryFixture(profile: SessionSubagentProfile) {
  const instance: SessionSubagentInstance = {
    agentId: "agent-1",
    profileId: profile.id,
    startedAt: "2026-08-08T00:00:00.000Z",
    status: "running",
    taskId: "task-1",
  };
  return {
    finishInstance: vi.fn(async (_agentId, status) => ({ ...instance, status })),
    get: vi.fn(async () => profile),
    instances: vi.fn(async () => []),
    list: vi.fn(async () => [profile]),
    remove: vi.fn(async () => undefined),
    startInstance: vi.fn(async () => instance),
  };
}

function subagentProfile(): SessionSubagentProfile {
  return {
    accessMode: "read-only",
    agentType: "code",
    createdAt: "2026-08-08T00:00:00.000Z",
    createdBy: "user",
    deliverable: "A focused review.",
    description: "Review code.",
    id: "profile-1",
    instructions: "Review behavior.",
    invocationMode: "manual",
    modelKey: "code",
    name: "reviewer",
    purpose: "code-review",
    role: "Review code.",
    scopes: ["."],
    skillSnapshots: [],
    source: "session",
  };
}
