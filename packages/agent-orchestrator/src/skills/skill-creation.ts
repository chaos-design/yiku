import { z } from "zod";
import type { SkillRuntime } from "./skill-runtime.js";
import type { SkillDescriptor } from "./skill-types.js";
import type { SkillRegistry } from "./types.js";

const skillDraftSchema = z
  .object({
    description: z.string().trim().min(1).max(200),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })
  .strict();

export interface SkillDraft {
  readonly description: string;
  readonly instructions: string;
  readonly name: string;
}

export interface SkillGenerator {
  generate(
    intent: string,
    options?: {
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<SkillDraft>;
}

export interface SkillStore {
  readonly source?: "project" | "user" | undefined;
  save(draft: SkillDraft): Promise<SkillDescriptor>;
}

export interface SkillCreationServiceOptions {
  readonly generator: SkillGenerator;
  readonly registry: SkillRegistry;
  readonly runtime: SkillRuntime;
  readonly store: SkillStore;
}

export interface CreateSkillOptions {
  readonly reservedNames?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class SkillCreationService {
  public constructor(private readonly options: SkillCreationServiceOptions) {}

  public async create(
    intent: string,
    createOptions: CreateSkillOptions = {},
  ): Promise<SkillDescriptor> {
    const normalizedIntent = intent.trim();
    if (!normalizedIntent) {
      throw new Error("Skill creation intent must be non-empty.");
    }

    const draft = parseSkillDraft(
      await this.options.generator.generate(normalizedIntent, {
        ...(createOptions.signal !== undefined ? { signal: createOptions.signal } : {}),
      }),
    );
    const reservedNames = new Set(createOptions.reservedNames ?? []);
    if (reservedNames.has(draft.name)) {
      throw new Error(`Skill name is reserved: ${draft.name}.`);
    }
    const registry = this.options.registry;
    const registered = registry.get(draft.name);
    const discovered = this.options.runtime.inspect(draft.name);
    const replace = registry.replace;
    const targetSource = this.options.store.source ?? "project";
    const canShadowDiscovered =
      discovered !== undefined &&
      sourcePriority(discovered.source) < sourcePriority(targetSource) &&
      (registered === undefined || registered.path === discovered.path);
    if (
      (discovered !== undefined &&
        sourcePriority(discovered.source) >= sourcePriority(targetSource)) ||
      (registered !== undefined && !canShadowDiscovered)
    ) {
      throw new Error(`Skill already exists: ${draft.name}.`);
    }
    if (registered !== undefined && replace === undefined) {
      throw new Error(`Skill registry cannot replace the existing Skill: ${draft.name}.`);
    }

    await this.options.store.save(draft);
    const discovery = await this.options.runtime.discover();
    const descriptor = this.options.runtime.inspect(draft.name);
    if (descriptor === undefined) {
      const diagnostic = discovery.diagnostics.find((item) => item.path.includes(draft.name));
      throw new Error(
        diagnostic === undefined
          ? `Created Skill was not discovered: ${draft.name}.`
          : `Created Skill is invalid: ${diagnostic.message}`,
      );
    }

    const skill = {
      description: descriptor.description,
      digest: descriptor.digest,
      instructions: descriptor.instructions,
      name: descriptor.name,
      path: descriptor.path,
      source: descriptor.source,
    };
    if (registered === undefined) {
      registry.register(skill);
    } else {
      replace?.call(registry, skill);
    }
    return descriptor;
  }
}

function sourcePriority(source: "builtin" | "project" | "user"): number {
  switch (source) {
    case "project":
      return 3;
    case "user":
      return 2;
    case "builtin":
      return 1;
  }
}

export function parseSkillDraft(value: unknown): SkillDraft {
  const parsed = skillDraftSchema.parse(value);
  return Object.freeze({
    description: parsed.description,
    instructions: parsed.instructions,
    name: parsed.name,
  });
}
