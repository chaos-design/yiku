import { dirname } from "node:path";
import type { HookComponentFrontmatter } from "@yiku/hooks";
import type { Hook } from "../hooks/types.js";
import type { PromptSegment } from "../prompt/types.js";
import type { Skill, SkillRegistry } from "./types.js";

export class DefaultSkillRegistry implements SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  public register(skill: Skill): void {
    const name = skill.name.trim();

    this.assertValidName(name);

    if (this.skills.has(name)) {
      throw new Error(`Skill already registered: ${name}.`);
    }

    this.skills.set(name, this.snapshotSkill(skill, name));
  }

  public replace(skill: Skill): void {
    const name = skill.name.trim();

    this.assertValidName(name);
    if (!this.skills.has(name)) {
      throw new Error(`Unknown skill: ${name}.`);
    }

    this.skills.set(name, this.snapshotSkill(skill, name));
  }

  public get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  public list(): readonly Skill[] {
    return Object.freeze([...this.skills.values()]);
  }

  public resolveTools(names?: readonly string[] | undefined) {
    return this.resolveSkills(names).flatMap((skill) => [...(skill.tools ?? [])]);
  }

  public resolveInstructions(names?: readonly string[] | undefined): string {
    return this.resolveSkills(names)
      .filter((skill) => skill.source !== "project")
      .map((skill) => formatInstructions(skill))
      .filter((instructions): instructions is string => Boolean(instructions))
      .join("\n\n");
  }

  public resolvePromptSegments(names?: readonly string[] | undefined): readonly PromptSegment[] {
    return Object.freeze(
      this.resolveSkills(names).flatMap((skill) => {
        if (skill.source !== "project") {
          return [];
        }
        const instructions = formatInstructions(skill);
        return instructions === undefined
          ? []
          : [
              Object.freeze({
                content: instructions,
                ...(skill.digest !== undefined ? { digest: skill.digest } : {}),
                kind: "instruction" as const,
                source: "skill" as const,
                sourceId: skill.name,
                trust: "untrusted" as const,
              }),
            ];
      }),
    );
  }

  public resolveHooks(names?: readonly string[] | undefined): readonly Hook[] {
    return this.resolveSkills(names).flatMap((skill) => [...(skill.hooks ?? [])]);
  }

  public resolveHookComponents(
    names?: readonly string[] | undefined,
  ): readonly HookComponentFrontmatter[] {
    return this.resolveSkills(names).flatMap((skill) =>
      skill.hookFrontmatter === undefined
        ? []
        : [
            {
              componentId: skill.name,
              content: skill.hookFrontmatter,
              ...(skill.path !== undefined ? { path: skill.path } : {}),
              type: "skill" as const,
            },
          ],
    );
  }

  private resolveSkills(names?: readonly string[] | undefined): readonly Skill[] {
    if (names === undefined) {
      return this.list();
    }

    return names.map((name) => {
      const skill = this.get(name);

      if (skill === undefined) {
        throw new Error(`Unknown skill: ${name}.`);
      }

      return skill;
    });
  }

  private assertValidName(name: string): void {
    if (!name) {
      throw new Error("Skill name is required.");
    }
  }

  private snapshotSkill(skill: Skill, name: string): Skill {
    return Object.freeze({
      ...skill,
      ...(skill.hooks !== undefined ? { hooks: Object.freeze([...skill.hooks]) } : {}),
      name,
      ...(skill.tools !== undefined ? { tools: Object.freeze([...skill.tools]) } : {}),
    });
  }
}

function formatInstructions(skill: Skill): string | undefined {
  const instructions = skill.instructions?.trim();
  if (!instructions) {
    return undefined;
  }
  if (skill.path === undefined) {
    return instructions;
  }
  return [
    `# Skill: ${skill.name}`,
    `Skill root: ${dirname(skill.path)}`,
    "Resolve relative paths in these instructions from the Skill root.",
    "",
    instructions,
  ].join("\n");
}
