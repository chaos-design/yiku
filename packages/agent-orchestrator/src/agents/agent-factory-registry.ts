import type { AgentFactory } from "./types.js";

export type AgentFactoryRegistryErrorCode = "AGENT_FACTORY_DUPLICATE" | "AGENT_TYPE_UNKNOWN";

export class AgentFactoryRegistryError extends Error {
  public override readonly name = "AgentFactoryRegistryError";

  public constructor(
    public readonly code: AgentFactoryRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class AgentFactoryRegistry {
  private readonly factories = new Map<string, AgentFactory>();

  public register(factory: AgentFactory): void {
    const type = factory.type.trim();
    if (!type) {
      throw new Error("Agent Factory type must be non-empty.");
    }
    if (this.factories.has(type)) {
      throw new AgentFactoryRegistryError(
        "AGENT_FACTORY_DUPLICATE",
        `Agent Factory is already registered: ${type}.`,
      );
    }
    this.factories.set(type, factory);
  }

  public get(type: string): AgentFactory | undefined {
    return this.factories.get(type.trim());
  }

  public list(): readonly AgentFactory[] {
    return Object.freeze(
      [...this.factories.values()].toSorted((left, right) => left.type.localeCompare(right.type)),
    );
  }

  public require(type: string): AgentFactory {
    const factory = this.get(type);
    if (factory === undefined) {
      throw new AgentFactoryRegistryError("AGENT_TYPE_UNKNOWN", `Unknown Agent type: ${type}.`);
    }
    return factory;
  }
}
