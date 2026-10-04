import type { Tool } from "@openai/agents";
import type { HookComponentFrontmatter } from "@yiku/hooks";
import type { Hook } from "../hooks/types.js";
import type { PromptSegment } from "../prompt/types.js";
import type { SkillSource } from "./skill-types.js";

export interface Skill {
  readonly description?: string | undefined;
  readonly digest?: string | undefined;
  readonly hooks?: readonly Hook[] | undefined;
  readonly hookFrontmatter?: string | undefined;
  readonly instructions?: string | undefined;
  readonly name: string;
  readonly path?: string | undefined;
  readonly source?: SkillSource | undefined;
  readonly tools?: readonly Tool[] | undefined;
}

export type SkillDefinition = Skill;
export type SkillToolFactory<TOptions = unknown> = (options: TOptions) => readonly Tool[];

export interface SkillRegistry {
  readonly get: (name: string) => Skill | undefined;
  readonly list: () => readonly Skill[];
  readonly register: (skill: Skill) => void;
  readonly replace?: ((skill: Skill) => void) | undefined;
  readonly resolveHookComponents: (
    names?: readonly string[] | undefined,
  ) => readonly HookComponentFrontmatter[];
  readonly resolveHooks: (names?: readonly string[] | undefined) => readonly Hook[];
  readonly resolveInstructions: (names?: readonly string[] | undefined) => string;
  readonly resolvePromptSegments: (
    names?: readonly string[] | undefined,
  ) => readonly PromptSegment[];
  readonly resolveTools: (names?: readonly string[] | undefined) => readonly Tool[];
}
