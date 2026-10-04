import type {
  SkillDescriptor,
  SkillDiagnostic,
  SkillDiscoveryResult,
  SkillSnapshot,
} from "./skill-types.js";
import { createSkillSnapshot } from "./skill-types.js";

export type SkillRuntimeErrorCode =
  | "SKILL_AGENT_TYPE_MISMATCH"
  | "SKILL_CAPABILITY_DENIED"
  | "SKILL_NOT_FOUND";

export class SkillRuntimeError extends Error {
  public override readonly name = "SkillRuntimeError";

  public constructor(
    public readonly code: SkillRuntimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SkillRuntimeOptions {
  readonly discovery: () => Promise<SkillDiscoveryResult>;
  readonly isMcpTargetAllowed?: ((target: string) => boolean) | undefined;
  readonly now?: (() => Date) | undefined;
}

export class SkillRuntime {
  private catalog = new Map<string, SkillDescriptor>();
  private current: SkillDiscoveryResult = emptyDiscoveryResult();
  private readonly isMcpTargetAllowed: (target: string) => boolean;
  private readonly now: () => Date;

  public constructor(private readonly options: SkillRuntimeOptions) {
    this.isMcpTargetAllowed = options.isMcpTargetAllowed ?? (() => true);
    this.now = options.now ?? (() => new Date());
  }

  public async discover(): Promise<SkillDiscoveryResult> {
    const discovered = await this.options.discovery();
    const catalog = new Map(discovered.skills.map((skill) => [skill.name, skill]));
    this.catalog = catalog;
    this.current = freezeDiscoveryResult(discovered);
    return this.current;
  }

  public diagnostics(): readonly SkillDiagnostic[] {
    return this.current.diagnostics;
  }

  public inspect(name: string): SkillDescriptor | undefined {
    return this.catalog.get(name.trim());
  }

  public list(): readonly SkillDescriptor[] {
    return Object.freeze(
      [...this.catalog.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public shadowed(): readonly SkillDescriptor[] {
    return this.current.shadowed;
  }

  public snapshot(names: readonly string[], agentType: string): readonly SkillSnapshot[] {
    const resolvedAt = this.now().toISOString();
    const normalizedAgentType = agentType.trim();
    const snapshots = [...new Set(names.map((name) => name.trim()).filter(Boolean))].map((name) => {
      const descriptor = this.catalog.get(name);
      if (descriptor === undefined) {
        throw new SkillRuntimeError("SKILL_NOT_FOUND", `Unknown Skill: ${name}.`);
      }
      if (!descriptor.agentTypes.includes(normalizedAgentType)) {
        throw new SkillRuntimeError(
          "SKILL_AGENT_TYPE_MISMATCH",
          `Skill ${name} does not support Agent type ${normalizedAgentType}.`,
        );
      }
      const deniedTarget = descriptor.mcpTargets.find((target) => !this.isMcpTargetAllowed(target));
      if (deniedTarget !== undefined) {
        throw new SkillRuntimeError(
          "SKILL_CAPABILITY_DENIED",
          `Skill ${name} MCP capability is denied: ${deniedTarget}.`,
        );
      }
      return createSkillSnapshot(descriptor, resolvedAt);
    });

    return Object.freeze(snapshots);
  }
}

function freezeDiscoveryResult(result: SkillDiscoveryResult): SkillDiscoveryResult {
  return Object.freeze({
    diagnostics: Object.freeze([...result.diagnostics]),
    shadowed: Object.freeze([...result.shadowed]),
    skills: Object.freeze([...result.skills]),
  });
}

function emptyDiscoveryResult(): SkillDiscoveryResult {
  return freezeDiscoveryResult({
    diagnostics: [],
    shadowed: [],
    skills: [],
  });
}
