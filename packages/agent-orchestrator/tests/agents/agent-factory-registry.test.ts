import type { Agent } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  AgentFactoryRegistry,
  type AgentFactoryRegistryError,
} from "../../src/agents/agent-factory-registry.js";

describe("AgentFactoryRegistry", () => {
  it("registers and resolves immutable Agent factories", () => {
    const registry = new AgentFactoryRegistry();
    const factory = {
      create: () => ({ agent: {} as Agent }),
      type: "code",
    };

    registry.register(factory);
    registry.register({
      create: () => ({ agent: {} as Agent }),
      type: "research",
    });

    expect(registry.get(" code ")).toBe(factory);
    expect(registry.require("code")).toBe(factory);
    expect(registry.list().map(({ type }) => type)).toEqual(["code", "research"]);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("rejects duplicate and unknown Agent types", () => {
    const registry = new AgentFactoryRegistry();
    expect(() =>
      registry.register({
        create: () => ({ agent: {} as Agent }),
        type: " ",
      }),
    ).toThrow("must be non-empty");
    registry.register({
      create: () => ({ agent: {} as Agent }),
      type: "code",
    });

    expect(() =>
      registry.register({
        create: () => ({ agent: {} as Agent }),
        type: "code",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentFactoryRegistryError>>({
        code: "AGENT_FACTORY_DUPLICATE",
      }),
    );
    expect(() => registry.require("research")).toThrowError(
      expect.objectContaining<Partial<AgentFactoryRegistryError>>({
        code: "AGENT_TYPE_UNKNOWN",
      }),
    );
  });
});
