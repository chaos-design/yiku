import { createHash } from "node:crypto";
import type { EnvVars, ModelsConfig } from "@yiku/config";
import type { PromptSegment } from "./types.js";

export interface ExtractProjectPromptInstructionsOptions {
  readonly config: ModelsConfig;
  readonly configPath: string;
  readonly env: EnvVars;
  readonly envPath: string;
}

export interface ExtractProjectPromptInstructionsResult {
  readonly config: ModelsConfig;
  readonly env: EnvVars;
  readonly segments: readonly PromptSegment[];
}

export function extractProjectPromptInstructions(
  options: ExtractProjectPromptInstructionsOptions,
): ExtractProjectPromptInstructionsResult {
  const config = cloneRecord(options.config);
  const env = { ...options.env };
  const segments: PromptSegment[] = [];

  extractConfigInstructions(config, "agents", options.configPath, segments);
  extractConfigInstructions(config, "models", options.configPath, segments);

  const environmentInstructions = env.AI_INSTRUCTIONS?.trim();
  delete env.AI_INSTRUCTIONS;
  if (environmentInstructions) {
    segments.push(
      instructionSegment(environmentInstructions, `${options.envPath}#AI_INSTRUCTIONS`),
    );
  }

  return Object.freeze({
    config,
    env,
    segments: Object.freeze(segments),
  });
}

function extractConfigInstructions(
  config: ModelsConfig,
  sectionName: "agents" | "models",
  configPath: string,
  segments: PromptSegment[],
): void {
  const section = asRecord(config[sectionName]);
  const items = asRecord(section?.items);
  if (items === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(items)) {
    const item = asRecord(value);
    const instructions = typeof item?.instructions === "string" ? item.instructions.trim() : "";
    if (item === undefined || !Object.hasOwn(item, "instructions")) {
      continue;
    }
    delete item.instructions;
    if (instructions) {
      segments.push(
        instructionSegment(instructions, `${configPath}#${sectionName}.items.${name}.instructions`),
      );
    }
  }
}

function instructionSegment(content: string, sourceId: string): PromptSegment {
  return Object.freeze({
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    kind: "instruction",
    source: "workspace",
    sourceId,
    trust: "untrusted",
  });
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  return asRecord(value) === undefined ? value : cloneRecord(value as Record<string, unknown>);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
