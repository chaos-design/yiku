import { z } from "zod";
import type { SkillDescriptor } from "../skills/skill-types.js";

export const AGENT_PROFILE_PURPOSES = [
  "code-review",
  "test-generation",
  "code-research",
  "feature-implementation",
  "custom",
] as const;
export const AGENT_PROFILE_INVOCATION_MODES = ["manual", "proactive"] as const;

export type AgentProfilePurpose = (typeof AGENT_PROFILE_PURPOSES)[number];
export type AgentProfileInvocationMode = (typeof AGENT_PROFILE_INVOCATION_MODES)[number];

export interface AgentWorkspaceScope {
  readonly description: string;
  readonly label: string;
  readonly path: string;
}

export interface AgentProfileRequirements {
  readonly intent?: string | undefined;
  readonly invocationMode?: AgentProfileInvocationMode | undefined;
  readonly purpose?: AgentProfilePurpose | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly triggerInstructions?: string | undefined;
}

export interface AgentProfileGenerationInput {
  readonly agentTypes: readonly string[];
  readonly availableScopes: readonly AgentWorkspaceScope[];
  readonly currentModelKey: string;
  readonly modelKeys: readonly string[];
  readonly parentAccessMode: "read-only" | "read-write";
  readonly requirements: AgentProfileRequirements;
  readonly skills: readonly SkillDescriptor[];
}

export interface AgentProfileDraft {
  readonly accessMode: "read-only" | "read-write";
  readonly agentType: string;
  readonly deliverable: string;
  readonly description: string;
  readonly instructions: string;
  readonly invocationMode: AgentProfileInvocationMode;
  readonly modelKey: string;
  readonly name: string;
  readonly purpose: AgentProfilePurpose;
  readonly role: string;
  readonly scopes: readonly string[];
  readonly skillNames: readonly string[];
  readonly triggerInstructions?: string | undefined;
}

export interface AgentProfileGenerator {
  generate(
    input: AgentProfileGenerationInput,
    options?: {
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<AgentProfileDraft>;
}

const generatedProfileSchema = z
  .object({
    accessMode: z.enum(["read-only", "read-write"]),
    agentType: z.string().trim().min(1).max(256),
    deliverable: z.string().trim().min(1).max(8_192),
    description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(32_768),
    invocationMode: z.enum(AGENT_PROFILE_INVOCATION_MODES),
    modelKey: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(128),
    purpose: z.enum(AGENT_PROFILE_PURPOSES),
    role: z.string().trim().min(1).max(8_192),
    scopes: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
    skillNames: z.array(z.string().trim().min(1).max(64)).max(24),
    triggerInstructions: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export function parseAgentProfileDraft(
  output: unknown,
  input: AgentProfileGenerationInput,
): AgentProfileDraft {
  const parsed = generatedProfileSchema.parse(output);
  assertAllowed("Agent type", parsed.agentType, input.agentTypes);
  assertAllowed("Model", parsed.modelKey, unique([input.currentModelKey, ...input.modelKeys]));
  if (input.parentAccessMode === "read-only" && parsed.accessMode !== "read-only") {
    throw new Error("Generated Agent Profile cannot exceed the parent access mode.");
  }

  const compatibleSkills = new Set(
    input.skills
      .filter((skill) => skill.agentTypes.includes(parsed.agentType))
      .map((skill) => skill.name),
  );
  for (const skillName of parsed.skillNames) {
    if (!compatibleSkills.has(skillName)) {
      throw new Error(`Generated Agent Profile selected an unavailable Skill: ${skillName}.`);
    }
  }

  assertLockedValue("purpose", input.requirements.purpose, parsed.purpose);
  assertLockedValue("invocation mode", input.requirements.invocationMode, parsed.invocationMode);
  if (
    input.requirements.scopes !== undefined &&
    !sameValues(input.requirements.scopes, parsed.scopes)
  ) {
    throw new Error("Generated Agent Profile changed the user-selected scopes.");
  }
  if (
    input.requirements.triggerInstructions !== undefined &&
    input.requirements.triggerInstructions.trim() !== parsed.triggerInstructions?.trim()
  ) {
    throw new Error("Generated Agent Profile changed the user trigger instructions.");
  }

  return Object.freeze({
    ...parsed,
    name: toAgentProfileName(parsed.name),
    scopes: Object.freeze(unique(parsed.scopes)),
    skillNames: Object.freeze(unique(parsed.skillNames)),
  });
}

export function toAgentProfileName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  if (!normalized) {
    throw new Error("Generated Agent Profile name must contain ASCII letters or numbers.");
  }
  return normalized;
}

function assertAllowed(label: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    throw new Error(`${label} is not available: ${value}.`);
  }
}

function assertLockedValue<T>(label: string, expected: T | undefined, actual: T): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Generated Agent Profile changed the user-selected ${label}.`);
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = unique(left);
  const normalizedRight = unique(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}
