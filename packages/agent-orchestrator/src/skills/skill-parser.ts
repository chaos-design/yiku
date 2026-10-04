import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  createSkillDescriptor,
  SKILL_MAX_CONTENT_BYTES,
  type SkillDescriptor,
  type SkillDiagnostic,
  type SkillSource,
} from "./skill-types.js";

const ALLOWED_FIELDS = new Set([
  "agentTypes",
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "mcp",
  "metadata",
  "name",
  "version",
]);

export type SkillParseResult =
  | {
      readonly descriptor: SkillDescriptor;
      readonly ok: true;
    }
  | {
      readonly diagnostic: SkillDiagnostic;
      readonly ok: false;
    };

export function parseSkillMarkdown(
  content: string,
  path: string,
  source: SkillSource,
): SkillParseResult {
  try {
    if (Buffer.byteLength(content, "utf8") > SKILL_MAX_CONTENT_BYTES) {
      throw new Error(`Skill content exceeds ${SKILL_MAX_CONTENT_BYTES} bytes.`);
    }

    const normalized = content.replaceAll("\r\n", "\n");
    const { body, frontmatter } = splitFrontmatter(normalized);
    const metadata = parse(frontmatter) as unknown;
    if (!isRecord(metadata)) {
      throw new Error("Skill frontmatter must be an object.");
    }

    const unknownFields = Object.keys(metadata).filter((field) => !ALLOWED_FIELDS.has(field));
    if (unknownFields.length > 0) {
      throw new Error(`Unknown Skill frontmatter field: ${unknownFields.toSorted()[0]}.`);
    }

    const name = requireString(metadata.name, "Skill name");
    const description = requireString(metadata.description, "Skill description");
    const version =
      metadata.version === undefined
        ? "0.0.0-local"
        : requireString(metadata.version, "Skill version");
    const allowedTools = readOptionalString(metadata["allowed-tools"], "Skill allowed-tools");
    const compatibility = readOptionalString(metadata.compatibility, "Skill compatibility");
    const license = readOptionalString(metadata.license, "Skill license");
    const skillMetadata = readMetadata(metadata.metadata);
    const agentTypes = readStringArray(metadata.agentTypes, "Skill agentTypes", ["code"]);
    const mcpTargets = readStringArray(metadata.mcp, "Skill mcp");
    const instructions = body.trim();
    const canonical = JSON.stringify({
      agentTypes: [...new Set(agentTypes)].toSorted(),
      allowedTools,
      compatibility,
      description,
      instructions,
      license,
      metadata: skillMetadata,
      mcpTargets: [...new Set(mcpTargets)].toSorted(),
      name,
      version,
    });
    const digest = createHash("sha256").update(canonical).digest("hex");

    return {
      descriptor: createSkillDescriptor({
        agentTypes,
        ...(allowedTools === undefined ? {} : { allowedTools }),
        ...(compatibility === undefined ? {} : { compatibility }),
        description,
        digest,
        instructions,
        ...(license === undefined ? {} : { license }),
        ...(skillMetadata === undefined ? {} : { metadata: skillMetadata }),
        mcpTargets,
        name,
        path,
        source,
        version,
      }),
      ok: true,
    };
  } catch (error) {
    return {
      diagnostic: Object.freeze({
        code: "SKILL_INVALID_FRONTMATTER",
        message: error instanceof Error ? error.message : String(error),
        path,
        severity: "error",
      }),
      ok: false,
    };
  }
}

function splitFrontmatter(content: string): {
  readonly body: string;
  readonly frontmatter: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("Skill frontmatter is required.");
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new Error("Skill frontmatter is not closed.");
  }

  return {
    body: lines.slice(closingIndex + 1).join("\n"),
    frontmatter: lines.slice(1, closingIndex).join("\n"),
  };
}

function readStringArray(
  value: unknown,
  label: string,
  fallback: readonly string[] = [],
): readonly string[] {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const items = value.map((item) => item.trim());
  if (items.some((item) => !item)) {
    throw new Error(`${label} must not contain empty values.`);
  }
  return items;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function readMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Skill metadata must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key.trim() || typeof item !== "string")) {
    throw new Error("Skill metadata must map non-empty keys to string values.");
  }
  return Object.freeze(
    Object.fromEntries(
      entries
        .map(([key, item]) => [key.trim(), (item as string).trim()] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
