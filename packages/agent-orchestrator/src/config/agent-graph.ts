import type { ModelsConfig } from "@yiku/config";
import type { HookComponentFrontmatter } from "@yiku/hooks";
import type { AgentDefinition, AgentGraph } from "../agents/types.js";

export function resolveAgentGraph(modelsConfig: ModelsConfig | undefined): AgentGraph {
  const agents = getAgentsSection(modelsConfig);
  const items = new Map<string, AgentDefinition>();

  for (const [key, value] of Object.entries(agents?.items ?? {})) {
    const definition = getAgentDefinition(key, value);

    if (definition !== undefined) {
      items.set(key, definition);
    }
  }

  return {
    ...(agents?.defaultAgentKey ? { defaultAgentKey: agents.defaultAgentKey } : {}),
    items,
  };
}

export function resolveAgentHookComponents(graph: AgentGraph): readonly HookComponentFrontmatter[] {
  return [...graph.items.values()].flatMap((agent) =>
    agent.hookFrontmatter === undefined
      ? []
      : [
          {
            componentId: agent.key,
            content: agent.hookFrontmatter,
            type: "agent" as const,
          },
        ],
  );
}

function getAgentsSection(modelsConfig: ModelsConfig | undefined):
  | {
      readonly defaultAgentKey?: string | undefined;
      readonly items?: Record<string, unknown> | undefined;
    }
  | undefined {
  const agents = modelsConfig?.agents;

  if (!isRecord(agents)) {
    return undefined;
  }

  return {
    ...(typeof agents.default === "string" ? { defaultAgentKey: agents.default } : {}),
    ...(isRecord(agents.items) ? { items: agents.items } : {}),
  };
}

function getAgentDefinition(key: string, value: unknown): AgentDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value, "name") ?? key;
  const delegates = readStringArray(value.delegates);
  const handoffs = readStringArray(value.handoffs);
  const skills = readStringArray(value.skills);

  return {
    ...(delegates !== undefined ? { delegates } : {}),
    ...(handoffs !== undefined ? { handoffs } : {}),
    ...(readString(value, "hookFrontmatter")
      ? { hookFrontmatter: readString(value, "hookFrontmatter") }
      : {}),
    ...(readString(value, "instructions")
      ? { instructions: readString(value, "instructions") }
      : {}),
    key,
    ...(readString(value, "model") ? { modelKey: readString(value, "model") } : {}),
    name,
    ...(skills !== undefined ? { skills } : {}),
    ...(readString(value, "type") ? { type: readString(value, "type") } : {}),
  };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
