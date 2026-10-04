import { createCodeEvalProfile } from "@yiku/agent-code";
import { createResearchEvalProfile } from "@yiku/agent-research";
import type { EvalPolicyMode, VerificationCommand } from "@yiku/evals";
import type {
  ResolvedCodeEvalProfile,
  ResolvedEvalConfig,
  ResolvedEvalProfile,
  ResolvedResearchEvalProfile,
} from "./types.js";
import {
  assertKnownFields,
  optionalRecord,
  requireBoolean,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

const MAX_CONCURRENT_RUNS = 8;
const MAX_CODE_COMMANDS = 25;
const MAX_TIMEOUT_MS = 3_600_000;

export function resolveEvalConfig(value: unknown): ResolvedEvalConfig {
  const section = optionalRecord(value, "evals");
  assertKnownFields(
    section,
    new Set([
      "enabled",
      "maxConcurrentRuns",
      "maxRepairAttempts",
      "mode",
      "profile",
      "profiles",
      "timeoutMs",
    ]),
    "evals",
  );
  const enabled = requireBoolean(section.enabled ?? true, "evals.enabled");
  const mode = policyMode(section.mode ?? "enforce", "evals.mode");
  const maxConcurrentRuns = boundedInteger(
    section.maxConcurrentRuns ?? 8,
    "evals.maxConcurrentRuns",
    MAX_CONCURRENT_RUNS,
  );
  const maxRepairAttempts = repairAttempts(
    section.maxRepairAttempts ?? 1,
    "evals.maxRepairAttempts",
  );
  const timeoutMs = boundedInteger(section.timeoutMs ?? 600_000, "evals.timeoutMs", MAX_TIMEOUT_MS);
  const profiles: Record<string, ResolvedEvalProfile> = {
    "code-default": codeProfile("code-default", {}, mode, maxRepairAttempts, timeoutMs),
    "research-default": researchProfile("research-default", {}, mode, maxRepairAttempts, timeoutMs),
  };
  for (const [id, configured] of Object.entries(
    optionalRecord(section.profiles, "evals.profiles"),
  )) {
    const path = `evals.profiles.${id}`;
    const profile = requireRecord(configured, path);
    const type = profile.type ?? (id.startsWith("research") ? "research" : "code");
    if (type !== "code" && type !== "research") {
      throw new Error(`${path}.type must be code or research.`);
    }
    profiles[id] =
      type === "code"
        ? codeProfile(id, profile, mode, maxRepairAttempts, timeoutMs)
        : researchProfile(id, profile, mode, maxRepairAttempts, timeoutMs);
  }
  const selected = optionalString(section.profile, "evals.profile");
  if (selected !== undefined && profiles[selected] === undefined) {
    throw new Error(`evals.profile references unknown profile: ${selected}.`);
  }
  return Object.freeze({
    enabled,
    maxConcurrentRuns,
    mode,
    ...(selected !== undefined ? { profile: selected } : {}),
    profiles: Object.freeze(profiles),
  });
}

export function evalProfileForAgent(
  config: ResolvedEvalConfig,
  agentType: string,
): ResolvedEvalProfile {
  const id = config.profile ?? (agentType === "research" ? "research-default" : "code-default");
  const profile = config.profiles[id];
  if (profile === undefined) {
    throw new Error(`Evaluation profile is unavailable: ${id}.`);
  }
  if (config.profile === undefined && profile.type !== agentType && agentType !== "custom") {
    throw new Error(`Evaluation profile ${id} does not support Agent type ${agentType}.`);
  }
  return profile;
}

function codeProfile(
  id: string,
  value: Readonly<Record<string, unknown>>,
  mode: EvalPolicyMode,
  defaultRepairAttempts: 0 | 1,
  defaultTimeoutMs: number,
): ResolvedCodeEvalProfile {
  const path = `evals.profiles.${id}`;
  assertKnownFields(
    value,
    new Set([
      "commands",
      "maxConcurrentChecks",
      "maxRepairAttempts",
      "qualityThreshold",
      "requireChanges",
      "timeoutMs",
      "type",
    ]),
    path,
  );
  const commands = readCommands(value.commands, `${path}.commands`);
  const maxConcurrentChecks = boundedInteger(
    value.maxConcurrentChecks ?? 4,
    `${path}.maxConcurrentChecks`,
    8,
  );
  const maxRepairAttempts = repairAttempts(
    value.maxRepairAttempts ?? defaultRepairAttempts,
    `${path}.maxRepairAttempts`,
  );
  const qualityThreshold = unitInterval(value.qualityThreshold ?? 0.8, `${path}.qualityThreshold`);
  const requireChanges = requireBoolean(value.requireChanges ?? false, `${path}.requireChanges`);
  const timeoutMs = boundedInteger(
    value.timeoutMs ?? defaultTimeoutMs,
    `${path}.timeoutMs`,
    MAX_TIMEOUT_MS,
  );
  return Object.freeze({
    commands,
    id,
    profile: createCodeEvalProfile({
      commands,
      id,
      maxConcurrentChecks,
      maxRepairAttempts,
      mode,
      qualityThreshold,
      requireChanges,
      timeoutMs,
    }),
    requireChanges,
    type: "code",
  });
}

function researchProfile(
  id: string,
  value: Readonly<Record<string, unknown>>,
  mode: EvalPolicyMode,
  defaultRepairAttempts: 0 | 1,
  defaultTimeoutMs: number,
): ResolvedResearchEvalProfile {
  const path = `evals.profiles.${id}`;
  assertKnownFields(
    value,
    new Set([
      "freshnessDays",
      "maxConcurrentChecks",
      "maxRepairAttempts",
      "minimumIndependentDomains",
      "qualityThreshold",
      "timeoutMs",
      "type",
    ]),
    path,
  );
  const freshnessDays = boundedInteger(value.freshnessDays ?? 180, `${path}.freshnessDays`, 3_650);
  const maxConcurrentChecks = boundedInteger(
    value.maxConcurrentChecks ?? 4,
    `${path}.maxConcurrentChecks`,
    8,
  );
  const maxRepairAttempts = repairAttempts(
    value.maxRepairAttempts ?? defaultRepairAttempts,
    `${path}.maxRepairAttempts`,
  );
  const minimumIndependentDomains = boundedInteger(
    value.minimumIndependentDomains ?? 2,
    `${path}.minimumIndependentDomains`,
    20,
  );
  const qualityThreshold = unitInterval(value.qualityThreshold ?? 0.8, `${path}.qualityThreshold`);
  const timeoutMs = boundedInteger(
    value.timeoutMs ?? defaultTimeoutMs,
    `${path}.timeoutMs`,
    MAX_TIMEOUT_MS,
  );
  return Object.freeze({
    freshnessDays,
    id,
    minimumIndependentDomains,
    profile: createResearchEvalProfile({
      freshnessDays,
      id,
      maxConcurrentChecks,
      maxRepairAttempts,
      minimumIndependentDomains,
      mode,
      qualityThreshold,
      timeoutMs,
    }),
    type: "research",
  });
}

function readCommands(value: unknown, path: string): readonly VerificationCommand[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > MAX_CODE_COMMANDS) {
    throw new Error(`${path} must contain at most ${MAX_CODE_COMMANDS} commands.`);
  }
  const ids = new Set<string>();
  return Object.freeze(
    value.map((entry, index) => {
      const itemPath = `${path}.${index}`;
      const item = requireRecord(entry, itemPath);
      assertKnownFields(
        item,
        new Set([
          "args",
          "command",
          "cwd",
          "envAllowlist",
          "id",
          "network",
          "timeoutMs",
          "writePolicy",
        ]),
        itemPath,
      );
      const id = requireNonEmptyString(item.id, `${itemPath}.id`);
      if (ids.has(id)) {
        throw new Error(`${path} contains duplicate command ID: ${id}.`);
      }
      ids.add(id);
      const args = stringArray(item.args, `${itemPath}.args`);
      const envAllowlist = stringArray(item.envAllowlist, `${itemPath}.envAllowlist`, ["PATH"]);
      const network = item.network ?? "deny";
      if (network !== "deny" && network !== "allowlist") {
        throw new Error(`${itemPath}.network must be deny or allowlist.`);
      }
      const writePolicy = item.writePolicy ?? "isolated";
      if (writePolicy !== "isolated" && writePolicy !== "read-only") {
        throw new Error(`${itemPath}.writePolicy must be isolated or read-only.`);
      }
      return Object.freeze({
        args,
        command: requireNonEmptyString(item.command, `${itemPath}.command`),
        cwd: optionalString(item.cwd, `${itemPath}.cwd`) ?? ".",
        envAllowlist,
        id,
        network,
        timeoutMs: boundedInteger(
          item.timeoutMs ?? 300_000,
          `${itemPath}.timeoutMs`,
          MAX_TIMEOUT_MS,
        ),
        writePolicy,
      });
    }),
  );
}

function policyMode(value: unknown, path: string): EvalPolicyMode {
  if (value !== "enforce" && value !== "observe") {
    throw new Error(`${path} must be enforce or observe.`);
  }
  return value;
}

function repairAttempts(value: unknown, path: string): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new Error(`${path} must be 0 or 1.`);
  }
  return value;
}

function boundedInteger(value: unknown, path: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${path} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function unitInterval(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be between 0 and 1.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, path);
}

function stringArray(
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
  if (new Set(result).size !== result.length) {
    throw new Error(`${path} must not contain duplicate values.`);
  }
  return Object.freeze(result);
}
