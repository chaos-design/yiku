import type { ModelsConfig } from "@yiku/config";
import { resolveEvalConfig } from "./eval-config.js";
import type {
  ResolvedFlowConfig,
  ResolvedHttpMcpServerConfig,
  ResolvedMcpServerConfig,
  ResolvedMemoryConfig,
  ResolvedRuntimeConfig,
  ResolvedSkillConfig,
  ResolvedStdioMcpServerConfig,
  ResolveRuntimeConfigOptions,
  RuntimeBudgetConfig,
  RuntimeBudgetOverrides,
} from "./types.js";
import {
  assertKnownFields,
  optionalRecord,
  requireBoolean,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

const BUILT_IN_SKILLS = new Set(["agents", "code", "delegate", "skills", "tasks"]);
const RUNTIME_FIELDS = new Set<keyof RuntimeBudgetConfig>([
  "autoContinue",
  "compactAtContextRatio",
  "compactToContextRatio",
  "maxNoProgressStages",
  "maxParallelReaders",
  "maxStageDurationMs",
  "maxStagesPerEpoch",
  "maxToolCallsPerStage",
  "maxTurnsPerStage",
]);
const RUNTIME_MAXIMUMS = {
  maxNoProgressStages: 100,
  maxParallelReaders: 32,
  maxStageDurationMs: 86_400_000,
  maxStagesPerEpoch: 1_000,
  maxToolCallsPerStage: 10_000,
  maxTurnsPerStage: 1_000,
} as const;

export const DEFAULT_RUNTIME_BUDGET_CONFIG: RuntimeBudgetConfig = Object.freeze({
  autoContinue: true,
  compactAtContextRatio: 0.7,
  compactToContextRatio: 0.25,
  maxNoProgressStages: 2,
  maxParallelReaders: 3,
  maxStageDurationMs: 1_800_000,
  maxStagesPerEpoch: 20,
  maxToolCallsPerStage: 200,
  maxTurnsPerStage: 100,
});

export function resolveRuntimeConfig(
  options: ResolveRuntimeConfigOptions = {},
): ResolvedRuntimeConfig {
  const merged = mergeRecords(options.userConfig ?? {}, options.projectConfig ?? {});
  const budget = resolveBudget(merged.runtime, options.overrides);
  const flow = resolveFlow(merged.flow);
  const evals = resolveEvalConfig(merged.evals);
  const memory = resolveMemory(merged.memory);
  const skills = resolveSkills(merged.skills);
  const mcpServers = resolveMcpServers(merged.mcp);
  const denied = new Set(options.managedDeniedCapabilities ?? []);

  validateSkillMcpReferences(skills, mcpServers, denied);
  validateAgentReferences(merged.agents, skills, denied);

  return Object.freeze({
    budget,
    evals,
    flow,
    memory,
    mcpServers,
    modelsConfig: deepFreeze(merged),
    skills,
  });
}

function resolveFlow(value: unknown): ResolvedFlowConfig {
  const section = optionalRecord(value, "flow");
  assertKnownFields(section, new Set(["trace"]), "flow");

  return Object.freeze({
    trace: requireBoolean(section.trace ?? false, "flow.trace"),
  });
}

function resolveMemory(value: unknown): ResolvedMemoryConfig {
  const section = optionalRecord(value, "memory");
  assertKnownFields(section, new Set(["enabled", "extraction", "failureMode"]), "memory");
  const failureMode = section.failureMode ?? "best-effort";
  if (failureMode !== "best-effort" && failureMode !== "strict") {
    throw new Error("memory.failureMode must be best-effort or strict.");
  }

  return Object.freeze({
    enabled: requireBoolean(section.enabled ?? true, "memory.enabled"),
    extraction: requireBoolean(section.extraction ?? true, "memory.extraction"),
    failureMode,
  });
}

function resolveBudget(
  configured: unknown,
  overrides: RuntimeBudgetOverrides | undefined,
): RuntimeBudgetConfig {
  const configuredRecord = optionalRecord(configured, "runtime");
  assertKnownFields(configuredRecord, RUNTIME_FIELDS, "runtime");
  const overrideRecord = (overrides ?? {}) as Readonly<Record<string, unknown>>;
  assertKnownFields(overrideRecord, RUNTIME_FIELDS, "runtime override");
  const values = {
    ...DEFAULT_RUNTIME_BUDGET_CONFIG,
    ...configuredRecord,
    ...overrideRecord,
  };
  const budget: RuntimeBudgetConfig = {
    autoContinue: requireBoolean(values.autoContinue, "runtime.autoContinue"),
    compactAtContextRatio: requireRatio(
      values.compactAtContextRatio,
      "runtime.compactAtContextRatio",
    ),
    compactToContextRatio: requireRatio(
      values.compactToContextRatio,
      "runtime.compactToContextRatio",
    ),
    maxNoProgressStages: requireBoundedInteger(
      values.maxNoProgressStages,
      "runtime.maxNoProgressStages",
      RUNTIME_MAXIMUMS.maxNoProgressStages,
    ),
    maxParallelReaders: requireBoundedInteger(
      values.maxParallelReaders,
      "runtime.maxParallelReaders",
      RUNTIME_MAXIMUMS.maxParallelReaders,
    ),
    maxStageDurationMs: requireBoundedInteger(
      values.maxStageDurationMs,
      "runtime.maxStageDurationMs",
      RUNTIME_MAXIMUMS.maxStageDurationMs,
    ),
    maxStagesPerEpoch: requireBoundedInteger(
      values.maxStagesPerEpoch,
      "runtime.maxStagesPerEpoch",
      RUNTIME_MAXIMUMS.maxStagesPerEpoch,
    ),
    maxToolCallsPerStage: requireBoundedInteger(
      values.maxToolCallsPerStage,
      "runtime.maxToolCallsPerStage",
      RUNTIME_MAXIMUMS.maxToolCallsPerStage,
    ),
    maxTurnsPerStage: requireBoundedInteger(
      values.maxTurnsPerStage,
      "runtime.maxTurnsPerStage",
      RUNTIME_MAXIMUMS.maxTurnsPerStage,
    ),
  };

  if (budget.compactToContextRatio >= budget.compactAtContextRatio) {
    throw new Error(
      "runtime.compactToContextRatio must be less than runtime.compactAtContextRatio.",
    );
  }

  return Object.freeze(budget);
}

function resolveSkills(value: unknown): Readonly<Record<string, ResolvedSkillConfig>> {
  const section = optionalRecord(value, "skills");
  assertKnownFields(section, new Set(["items"]), "skills");
  const items = optionalRecord(section.items, "skills.items");
  const resolved: Record<string, ResolvedSkillConfig> = {};

  for (const [name, raw] of Object.entries(items)) {
    const path = `skills.items.${name}`;
    const item = requireRecord(raw, path);
    assertKnownFields(item, new Set(["instructions", "mcp"]), path);
    const instructions = optionalNonEmptyString(item.instructions, `${path}.instructions`);
    const mcp = readStringArray(item.mcp, `${path}.mcp`);

    resolved[name] = Object.freeze({
      ...(instructions !== undefined ? { instructions } : {}),
      mcp,
      name,
    });
  }

  return Object.freeze(resolved);
}

function resolveMcpServers(value: unknown): Readonly<Record<string, ResolvedMcpServerConfig>> {
  const section = optionalRecord(value, "mcp");
  assertKnownFields(section, new Set(["servers"]), "mcp");
  const servers = optionalRecord(section.servers, "mcp.servers");
  const resolved: Record<string, ResolvedMcpServerConfig> = {};

  for (const [name, raw] of Object.entries(servers)) {
    const path = `mcp.servers.${name}`;
    const item = requireRecord(raw, path);
    const transport = requireNonEmptyString(item.transport, `${path}.transport`);
    if (transport !== "stdio" && transport !== "streamable-http") {
      throw new Error(`${path}.transport must be "stdio" or "streamable-http".`);
    }

    resolved[name] =
      transport === "stdio"
        ? resolveStdioMcpServer(name, item, path)
        : resolveHttpMcpServer(name, item, path);
  }

  return Object.freeze(resolved);
}

function resolveStdioMcpServer(
  name: string,
  item: Readonly<Record<string, unknown>>,
  path: string,
): ResolvedStdioMcpServerConfig {
  assertKnownFields(item, new Set(["args", "command", "cwd", "env", "tools", "transport"]), path);
  const cwd = optionalNonEmptyString(item.cwd, `${path}.cwd`);

  return Object.freeze({
    args: readStringArray(item.args, `${path}.args`),
    command: requireNonEmptyString(item.command, `${path}.command`),
    ...(cwd !== undefined ? { cwd } : {}),
    env: readStringArray(item.env, `${path}.env`),
    name,
    tools: readStringArray(item.tools, `${path}.tools`, ["*"]),
    transport: "stdio",
  });
}

function resolveHttpMcpServer(
  name: string,
  item: Readonly<Record<string, unknown>>,
  path: string,
): ResolvedHttpMcpServerConfig {
  assertKnownFields(
    item,
    new Set(["allowedEnvVars", "headers", "tools", "transport", "url"]),
    path,
  );
  const url = requireNonEmptyString(item.url, `${path}.url`);
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${path}.url must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${path}.url must be a valid HTTPS URL.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${path}.url must not contain credentials, query parameters, or fragments.`);
  }

  return Object.freeze({
    allowedEnvVars: readStringArray(item.allowedEnvVars, `${path}.allowedEnvVars`),
    headers: readStringRecord(item.headers, `${path}.headers`),
    name,
    tools: readStringArray(item.tools, `${path}.tools`, ["*"]),
    transport: "streamable-http",
    url: parsed.toString(),
  });
}

function validateSkillMcpReferences(
  skills: Readonly<Record<string, ResolvedSkillConfig>>,
  servers: Readonly<Record<string, ResolvedMcpServerConfig>>,
  denied: ReadonlySet<string>,
): void {
  for (const skill of Object.values(skills)) {
    for (const target of skill.mcp) {
      const server = target.split("/", 1)[0];
      if (!server || servers[server] === undefined) {
        throw new Error(`Unknown MCP server in skills.items.${skill.name}.mcp: ${server ?? ""}`);
      }
      requireAllowed(denied, `mcp:${server}`);
    }
  }
}

function validateAgentReferences(
  value: unknown,
  skills: Readonly<Record<string, ResolvedSkillConfig>>,
  denied: ReadonlySet<string>,
): void {
  const agents = optionalRecord(value, "agents");
  const items = optionalRecord(agents.items, "agents.items");
  const knownAgents = new Set(Object.keys(items));

  for (const [key, raw] of Object.entries(items)) {
    if (!isRecord(raw)) {
      continue;
    }

    for (const skill of readStringArray(raw.skills, `agents.items.${key}.skills`)) {
      if (!BUILT_IN_SKILLS.has(skill) && skills[skill] === undefined) {
        throw new Error(`Unknown skill in agents.items.${key}.skills: ${skill}`);
      }
      requireAllowed(denied, `skill:${skill}`);
    }

    for (const delegate of readStringArray(raw.delegates, `agents.items.${key}.delegates`)) {
      if (!knownAgents.has(delegate)) {
        throw new Error(`Unknown delegate in agents.items.${key}.delegates: ${delegate}`);
      }
      requireAllowed(denied, `agent:${delegate}`);
    }
  }
}

function requireAllowed(denied: ReadonlySet<string>, capability: string): void {
  if (denied.has(capability)) {
    throw new Error(`Capability is denied by managed policy: ${capability}`);
  }
}

function mergeRecords(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): ModelsConfig {
  const merged: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const baseValue = base[key];
    const overrideValue = override[key];

    merged[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeRecords(baseValue, overrideValue)
        : cloneJson(overrideValue === undefined ? baseValue : overrideValue);
  }

  return merged;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  if (isRecord(value)) {
    return mergeRecords({}, value);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
  }

  return typeof value === "object" && value !== null ? Object.freeze(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBoundedInteger(value: unknown, path: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
  if (value > maximum) {
    throw new Error(`${path} must not exceed ${maximum}.`);
  }
  return value;
}

function requireRatio(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${path} must be between 0 and 1.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, path);
}

function readStringArray(
  value: unknown,
  path: string,
  fallback: readonly string[] = [],
): readonly string[] {
  if (value === undefined) {
    return Object.freeze([...fallback]);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings.`);
  }

  const result = value.map((item, index) => requireNonEmptyString(item, `${path}.${index}`));
  return Object.freeze([...new Set(result)]);
}

function readStringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
  const record = optionalRecord(value, path);
  const result: Record<string, string> = {};

  for (const [key, item] of Object.entries(record)) {
    result[key] = requireNonEmptyString(item, `${path}.${key}`);
  }
  return Object.freeze(result);
}
