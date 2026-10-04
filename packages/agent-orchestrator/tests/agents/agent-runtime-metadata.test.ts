import { Agent } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  createAgentIdentityResolver,
  createRegisteredAgent,
  getAgentGraphMembers,
  getAgentRuntimeMetadata,
  inheritAgentRuntimeMetadata,
  registerAgentFactoryResult,
  registerAgentGraph,
} from "../../src/agents/agent-runtime-metadata.js";
import type {
  AgentFactory,
  AgentFactoryInput,
  AgentFactoryResult,
} from "../../src/agents/types.js";

interface ArtifactFactoryResult extends AgentFactoryResult {
  readonly artifact: string;
}

describe("agent runtime metadata", () => {
  it("registers concrete factory results without erasing artifacts", async () => {
    const factory: AgentFactory<ArtifactFactoryResult> = {
      create: (input) => ({
        agent: createAgent(input.agentName),
        artifact: "evidence",
        validateOutput: async (output) => ({
          diagnostics: output === "valid" ? [] : ["invalid"],
          passed: output === "valid",
        }),
      }),
      type: "research",
    };
    const result = createRegisteredAgent(factory, factoryInput("Research"), {
      agentId: "research",
      agentKey: "research",
      agentType: "research",
    });

    expect(result.artifact).toBe("evidence");
    expect(getAgentRuntimeMetadata(result.agent)?.identity).toEqual({
      agentId: "research",
      agentKey: "research",
      agentName: "Research",
      agentType: "research",
    });
    await expect(getAgentRuntimeMetadata(result.agent)?.validateOutput?.("valid")).resolves.toEqual(
      {
        diagnostics: [],
        passed: true,
      },
    );
  });

  it("resolves same-name graph agents by instance and inherits cloned root metadata", () => {
    const root = createAgent("Agent");
    const handoff = createAgent("Agent");
    registerAgentFactoryResult({ agent: root }, { agentId: "root", agentType: "code" });
    registerAgentFactoryResult({ agent: handoff }, { agentId: "handoff", agentType: "research" });
    registerAgentGraph(root, [handoff, root]);
    const resolver = createAgentIdentityResolver(root, "run-1");

    expect(getAgentGraphMembers(root)).toEqual([root, handoff]);
    expect(resolver(root).agentId).toBe("root");
    expect(resolver(handoff).agentId).toBe("handoff");

    const clone = createAgent("Agent");
    inheritAgentRuntimeMetadata(root, clone);
    expect(resolver(clone)).toEqual(resolver(root));
    expect(getAgentGraphMembers(clone)).toEqual([clone, handoff]);
  });

  it("creates stable run-scoped fallback identities", () => {
    const root = createAgent("Root");
    const unknown = createAgent("Unknown");
    const resolver = createAgentIdentityResolver(root, "run-fallback");

    expect(resolver(root)).toEqual(resolver(root));
    expect(resolver(unknown)).toEqual(resolver(unknown));
    expect(resolver(root).agentId).not.toBe(resolver(unknown).agentId);
    expect(resolver(unknown)).toMatchObject({
      agentName: "Unknown",
      agentType: "custom",
    });
  });
});

function createAgent(name: string): Agent {
  return new Agent({
    instructions: "Test.",
    model: "gpt-test",
    name,
  });
}

function factoryInput(agentName: string): AgentFactoryInput {
  return {
    agentName,
    handoffs: [],
    model: "gpt-test",
    tools: [],
    workspaceDir: "/workspace",
  };
}
