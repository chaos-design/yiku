import { isAbsolute } from "node:path";
import { requireText } from "../validation.js";

export const SKILL_MAX_CONTENT_BYTES = 64 * 1024;
export const SKILL_MAX_DESCRIPTION_CHARACTERS = 1_024;
export const SKILL_MAX_NAME_CHARACTERS = 64;
const SKILL_MAX_COMPATIBILITY_CHARACTERS = 500;
const SKILL_MAX_OPTIONAL_TEXT_CHARACTERS = 4_096;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type SkillSource = "builtin" | "project" | "user";
export type SkillDiagnosticSeverity = "error" | "info" | "warning";

export interface SkillDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly severity: SkillDiagnosticSeverity;
}

export interface SkillDescriptor {
  readonly agentTypes: readonly string[];
  readonly allowedTools?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly description: string;
  readonly digest: string;
  readonly instructions: string;
  readonly license?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly mcpTargets: readonly string[];
  readonly name: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly version: string;
}

export interface SkillSnapshot extends SkillDescriptor {
  readonly resolvedAt: string;
}

export interface SkillDiscoveryResult {
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly shadowed: readonly SkillDescriptor[];
  readonly skills: readonly SkillDescriptor[];
}

export interface CreateSkillDescriptorInput extends SkillDescriptor {}

export function createSkillDescriptor(input: CreateSkillDescriptorInput): SkillDescriptor {
  const name = requireSkillName(input.name, "Skill name");
  const description = requireBoundedText(
    input.description,
    SKILL_MAX_DESCRIPTION_CHARACTERS,
    "Skill description",
  );
  const instructions = input.instructions.trim();
  const contentBytes = Buffer.byteLength(instructions, "utf8");
  if (contentBytes > SKILL_MAX_CONTENT_BYTES) {
    throw new Error(`Skill content exceeds ${SKILL_MAX_CONTENT_BYTES} bytes.`);
  }
  if (!SKILL_DIGEST_PATTERN.test(input.digest)) {
    throw new Error("Skill digest must be a lowercase SHA-256 hex string.");
  }
  if (!isAbsolute(input.path)) {
    throw new Error("Skill path must be absolute.");
  }
  if (input.source !== "builtin" && input.source !== "project" && input.source !== "user") {
    throw new Error("Skill source must be builtin, project, or user.");
  }
  if (input.version !== "0.0.0-local" && !SEMVER_PATTERN.test(input.version)) {
    throw new Error("Skill version must be valid SemVer.");
  }
  const allowedTools = optionalBoundedText(
    input.allowedTools,
    SKILL_MAX_OPTIONAL_TEXT_CHARACTERS,
    "Skill allowed-tools",
  );
  const compatibility = optionalBoundedText(
    input.compatibility,
    SKILL_MAX_COMPATIBILITY_CHARACTERS,
    "Skill compatibility",
  );
  const license = optionalBoundedText(
    input.license,
    SKILL_MAX_OPTIONAL_TEXT_CHARACTERS,
    "Skill license",
  );
  const metadata = freezeMetadata(input.metadata);

  return Object.freeze({
    agentTypes: freezeUnique(
      input.agentTypes.map((agentType) => requireSkillName(agentType, "Agent type")),
    ),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(compatibility === undefined ? {} : { compatibility }),
    description,
    digest: input.digest,
    instructions,
    ...(license === undefined ? {} : { license }),
    ...(metadata === undefined ? {} : { metadata }),
    mcpTargets: freezeUnique(input.mcpTargets.map((target) => requireText(target, "MCP target"))),
    name,
    path: input.path,
    source: input.source,
    version: input.version,
  });
}

export function createSkillSnapshot(
  descriptor: SkillDescriptor,
  resolvedAt = new Date().toISOString(),
): SkillSnapshot {
  if (Number.isNaN(Date.parse(resolvedAt))) {
    throw new Error("Skill snapshot resolvedAt must be a valid date.");
  }

  return Object.freeze({
    ...descriptor,
    agentTypes: Object.freeze([...descriptor.agentTypes]),
    ...(descriptor.metadata === undefined
      ? {}
      : { metadata: Object.freeze({ ...descriptor.metadata }) }),
    mcpTargets: Object.freeze([...descriptor.mcpTargets]),
    resolvedAt,
  });
}

function requireSkillName(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (normalized.length > SKILL_MAX_NAME_CHARACTERS || !SKILL_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must use kebab-case and contain at most ${SKILL_MAX_NAME_CHARACTERS} characters.`,
    );
  }
  return normalized;
}

function requireBoundedText(value: string, maximum: number, label: string): string {
  const normalized = requireText(value, label);
  if (normalized.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} characters.`);
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  maximum: number,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requireBoundedText(value, maximum, label);
}

function freezeMetadata(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, item]) => [requireText(key, "Skill metadata key"), item] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  for (const [, item] of entries) {
    if (typeof item !== "string") {
      throw new Error("Skill metadata values must be strings.");
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function freezeUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].toSorted((left, right) => left.localeCompare(right)));
}
