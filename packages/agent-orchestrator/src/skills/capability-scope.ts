import type { Tool } from "@openai/agents";
import { CodeToolset, type CodeToolsOptions } from "@yiku/agent-code";
import type { HookComponentFrontmatter } from "@yiku/hooks";
import type { Hook } from "../hooks/types.js";
import type { PromptSegment } from "../prompt/types.js";
import { DefaultSkillRegistry } from "./registry.js";
import type { Skill, SkillRegistry } from "./types.js";

const DEFAULT_SKILLS = ["code", "tasks"] as const;
const BUILT_IN_SKILLS = new Set(["agents", "code", "delegate", "skills", "tasks"]);

export interface CapabilityScopeOptions extends CodeToolsOptions {
  readonly builtInSkills?: Readonly<Record<string, Skill>> | undefined;
  readonly registry?: SkillRegistry | undefined;
  readonly skillTools?: Readonly<Record<string, readonly Tool[]>> | undefined;
}

export class CapabilityScope {
  private readonly builtInSkills: Readonly<Record<string, Skill>>;
  private readonly codeToolset: CodeToolset;
  private readonly registry: SkillRegistry;
  private readonly skillTools: Readonly<Record<string, readonly Tool[]>>;
  private closed = false;

  public constructor(options: CapabilityScopeOptions = {}) {
    this.builtInSkills = Object.freeze({ ...options.builtInSkills });
    this.registry = options.registry ?? new DefaultSkillRegistry();
    this.skillTools = Object.freeze(
      Object.fromEntries(
        Object.entries(options.skillTools ?? {}).map(([name, tools]) => [
          name,
          Object.freeze([...tools]),
        ]),
      ),
    );
    this.assertBuiltInNamesAvailable();
    this.codeToolset = new CodeToolset(options);
  }

  public resolveTools(names: readonly string[] = DEFAULT_SKILLS): readonly Tool[] {
    const tools = names.flatMap((name) => this.resolveSkillTools(name));
    const resolved = new Map<string, Tool>();

    for (const tool of tools) {
      if (resolved.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}.`);
      }
      resolved.set(tool.name, tool);
    }

    return Object.freeze([...resolved.values()]);
  }

  public resolveInstructions(names: readonly string[] = DEFAULT_SKILLS): string {
    return names
      .map((name) =>
        BUILT_IN_SKILLS.has(name)
          ? this.builtInSkills[name]?.instructions?.trim()
          : this.registry.resolveInstructions([name]),
      )
      .filter((instructions): instructions is string => Boolean(instructions))
      .join("\n\n");
  }

  public resolvePromptSegments(
    names: readonly string[] = DEFAULT_SKILLS,
  ): readonly PromptSegment[] {
    const registered = names.filter((name) => !BUILT_IN_SKILLS.has(name));
    return registered.length === 0
      ? Object.freeze([])
      : Object.freeze([...this.registry.resolvePromptSegments(registered)]);
  }

  public resolveHooks(names: readonly string[] = DEFAULT_SKILLS): readonly Hook[] {
    return Object.freeze(
      names.flatMap((name) =>
        BUILT_IN_SKILLS.has(name)
          ? [...(this.builtInSkills[name]?.hooks ?? [])]
          : [...(this.registry.get(name)?.hooks ?? [])],
      ),
    );
  }

  public resolveHookComponents(
    names: readonly string[] = DEFAULT_SKILLS,
  ): readonly HookComponentFrontmatter[] {
    const registered = names.filter((name) => !BUILT_IN_SKILLS.has(name));
    return registered.length === 0
      ? Object.freeze([])
      : Object.freeze([...this.registry.resolveHookComponents(registered)]);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.codeToolset.close();
  }

  private resolveSkillTools(name: string): readonly Tool[] {
    switch (name) {
      case "code":
        return this.codeToolset.tools.filter((tool) => tool.name !== "todoWriteTool");
      case "tasks":
        return this.codeToolset.tools.filter((tool) => tool.name === "todoWriteTool");
      case "delegate":
        return [];
      case "agents":
      case "skills":
        return Object.freeze([...(this.builtInSkills[name]?.tools ?? [])]);
      default: {
        const tools = this.registry.resolveTools([name]);
        return Object.freeze([...tools, ...(this.skillTools[name] ?? [])]);
      }
    }
  }

  private assertBuiltInNamesAvailable(): void {
    for (const name of BUILT_IN_SKILLS) {
      if (this.registry.get(name) !== undefined) {
        throw new Error(`Skill name is reserved: ${name}.`);
      }
    }
  }
}
