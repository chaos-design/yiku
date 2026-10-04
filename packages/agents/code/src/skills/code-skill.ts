import { CodeToolset, type CodeToolsOptions } from "../tools/index.js";
import type { CodeSkill } from "./types.js";

export interface CreateCodeSkillOptions extends CodeToolsOptions {
  readonly instructions?: string | undefined;
}

export function createCodeSkill(options: CreateCodeSkillOptions = {}): {
  readonly close: () => void;
  readonly skill: CodeSkill;
} {
  const toolset = new CodeToolset(options);

  return {
    close: () => toolset.close(),
    skill: {
      description: "Code editing, shell, filesystem, search, and todo capabilities.",
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      name: "code",
      tools: toolset.tools,
    },
  };
}
