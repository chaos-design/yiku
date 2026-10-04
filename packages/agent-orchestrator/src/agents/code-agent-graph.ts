import type { Agent, Tool } from "@openai/agents";
import type { EnvVars, ModelsConfig } from "@yiku/config";
import { resolveAgentGraph, resolveModelConfig } from "../config/index.js";
import { PROMPT_TRUST_POLICY } from "../prompt/context.js";
import type { PromptSegment } from "../prompt/types.js";
import type { CapabilityScope } from "../skills/capability-scope.js";
import { AgentFactoryRegistry } from "./agent-factory-registry.js";
import {
  createRegisteredAgent,
  getAgentRuntimeMetadata,
  registerAgentGraph,
} from "./agent-runtime-metadata.js";
import { CodeAgentFactory } from "./code-agent-factory.js";
import { ResearchAgentFactory } from "./research-agent-factory.js";

const DEFAULT_CODE_AGENT_SKILLS = ["agents", "code", "skills", "tasks"] as const;
const DEFAULT_OTHER_AGENT_SKILLS = ["skills"] as const;

export class AgentOutputValidationError extends Error {
  public override readonly name = "AgentOutputValidationError";

  public constructor(public readonly diagnostics: readonly string[]) {
    super(`Agent output validation failed: ${diagnostics.join("; ") || "invalid output"}.`);
  }
}

export interface BuildCodeAgentGraphOptions {
  readonly activatedSkills?: readonly string[] | undefined;
  readonly additionalInstructions?: string | undefined;
  readonly agentKey: string;
  readonly agentName: string;
  readonly agentType?: string | undefined;
  readonly delegateTools?:
    | ((agentKey: string, delegates: readonly string[]) => readonly Tool[])
    | undefined;
  readonly env: EnvVars;
  readonly factoryRegistry?: AgentFactoryRegistry | undefined;
  readonly instructions?: string | undefined;
  readonly memoryContext?: string | undefined;
  readonly modelKey: string;
  readonly modelsConfig: ModelsConfig;
  readonly onPromptSegments?: ((segments: readonly PromptSegment[]) => void) | undefined;
  readonly scope: CapabilityScope;
  readonly workspaceDir: string;
}

export function buildCodeAgentGraph(options: BuildCodeAgentGraphOptions): Agent {
  const graph = resolveAgentGraph(options.modelsConfig);
  const factoryRegistry = options.factoryRegistry ?? defaultAgentFactoryRegistry();
  const members: Agent[] = [];
  const visited = new Set<string>();

  const createAgent = (agentKey: string): Agent => {
    if (visited.has(agentKey)) {
      throw new Error(`Agent handoff cycle detected: ${agentKey}.`);
    }

    visited.add(agentKey);
    try {
      const definition = graph.items.get(agentKey);
      const resolvedModel = resolveModelConfig({
        env: options.env,
        modelKey:
          agentKey === options.agentKey
            ? options.modelKey
            : (definition?.modelKey ?? options.modelKey),
        modelsConfig: options.modelsConfig,
      });
      const handoffs = (definition?.handoffs ?? []).map(createAgent);
      const agentType =
        agentKey === options.agentKey
          ? (options.agentType ?? definition?.type ?? "code")
          : (definition?.type ?? "code");
      const skillNames = unique([
        ...(definition?.skills ?? defaultAgentSkills(agentType)),
        "skills",
        ...(agentKey === options.agentKey ? (options.activatedSkills ?? []) : []),
      ]);
      const skillInstructions = options.scope.resolveInstructions(skillNames);
      options.onPromptSegments?.([
        ...options.scope.resolvePromptSegments(skillNames),
        ...(agentKey === options.agentKey && options.memoryContext?.trim()
          ? [
              {
                content: options.memoryContext,
                kind: "reference" as const,
                source: "memory" as const,
                sourceId: "legacy-memory-context",
                trust: "untrusted" as const,
              },
            ]
          : []),
      ]);
      const tools = [
        ...options.scope.resolveTools(skillNames),
        ...(skillNames.includes("delegate") && options.delegateTools !== undefined
          ? options.delegateTools(agentKey, definition?.delegates ?? [])
          : []),
      ];
      assertUniqueToolNames(tools);
      const instructions = appendInstructions(
        PROMPT_TRUST_POLICY,
        definition?.instructions ?? resolvedModel.instructions ?? options.instructions,
        options.additionalInstructions,
        skillInstructions,
      );
      const factory = factoryRegistry.require(agentType);
      const created = createRegisteredAgent(
        factory,
        {
          agentName: definition?.name ?? options.agentName,
          handoffs,
          ...(instructions !== undefined ? { instructions } : {}),
          model: resolvedModel.model,
          tools,
          workspaceDir: options.workspaceDir,
        },
        {
          agentId: agentKey,
          agentKey,
          agentType,
        },
      );
      members.push(created.agent);
      return created.agent;
    } finally {
      visited.delete(agentKey);
    }
  };

  const root = createAgent(options.agentKey);
  registerAgentGraph(root, members);
  return root;
}

export async function validateAgentOutput(agent: Agent, output: unknown): Promise<void> {
  const validate = getAgentRuntimeMetadata(agent)?.validateOutput;
  if (validate === undefined) {
    return;
  }
  const result = await validate(output);
  if (!result.passed) {
    throw new AgentOutputValidationError(result.diagnostics);
  }
}

function defaultAgentFactoryRegistry(): AgentFactoryRegistry {
  const registry = new AgentFactoryRegistry();
  registry.register(new CodeAgentFactory());
  registry.register(new ResearchAgentFactory());
  return registry;
}

function defaultAgentSkills(agentType: string): readonly string[] {
  return agentType === "code" ? DEFAULT_CODE_AGENT_SKILLS : DEFAULT_OTHER_AGENT_SKILLS;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function assertUniqueToolNames(tools: readonly Tool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}.`);
    }
    names.add(tool.name);
  }
}

function appendInstructions(...values: ReadonlyArray<string | undefined>): string | undefined {
  const resolved = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return resolved.length === 0 ? undefined : resolved.join("\n\n");
}
