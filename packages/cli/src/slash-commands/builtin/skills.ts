import type { LocalSlashCommand, SlashCommandLineColor, SlashCommandSkill } from "../types.js";

const SKILL_GROUPS = [
  { color: "cyan", label: "BUILTIN", source: "builtin" },
  { color: "magenta", label: "PROJECT", source: "project" },
  { color: "yellow", label: "USER", source: "user" },
  { color: "white", label: "CONFIGURED", source: "configured" },
] as const satisfies readonly {
  readonly color: SlashCommandLineColor;
  readonly label: string;
  readonly source: "builtin" | "configured" | "project" | "user";
}[];

interface SkillsPresentation {
  readonly lineColors: readonly SlashCommandLineColor[];
  readonly lineIndents: readonly number[];
  readonly message: string;
}

export const skillsCommand: LocalSlashCommand = {
  kind: "local",
  description: "List, install, or create user Skills",
  execute: async (context, arguments_) => {
    const intent = arguments_.raw.trim();
    const [operation, ...operationArguments] = arguments_.values;
    if (operation === "install") {
      if (operationArguments.length < 1 || operationArguments.length > 2) {
        return usageError();
      }
      const [source, selector] = operationArguments;
      if (source === undefined) {
        return usageError();
      }
      return skillResult(await context.installSkill(source, selector), "Skill Installed");
    }
    if (operation === "create") {
      const createIntent = operationArguments.join(" ").trim();
      return createIntent
        ? skillResult(await context.createSkill(createIntent), "Skill Created")
        : usageError();
    }
    if (operation === "list") {
      if (operationArguments.length > 0) {
        return usageError();
      }
    } else if (intent) {
      return skillResult(await context.createSkill(intent), "Skill Created");
    }

    const skills = context.listSkills();
    if (skills.length === 0) {
      return {
        kind: "success",
        message: "No Skill commands are configured.",
        title: "Skills (0)",
      };
    }

    const presentation = presentSkills(skills);
    return {
      kind: "success",
      ...presentation,
      title: `Skills (${skills.length})`,
    };
  },
  name: "skills",
  source: "builtin",
  progressLabel: "Updating Skills...",
};

function skillResult(skill: SlashCommandSkill, title: string) {
  return {
    kind: "success" as const,
    lineColors: ["white", "white", "green"] as const,
    message: [
      `Name: ${skill.name}`,
      `Path: ${skill.path ?? "Created"}`,
      `Command: /${skill.name}`,
    ].join("\n"),
    title,
  };
}

function usageError() {
  return {
    kind: "error" as const,
    message:
      "Usage: /skills [list] | /skills install <source> [skill] | /skills create <description>",
    title: "Command Error",
  };
}

function presentSkills(skills: readonly SlashCommandSkill[]): SkillsPresentation {
  const lines: string[] = [];
  const lineColors: SlashCommandLineColor[] = [];
  const lineIndents: number[] = [];

  for (const group of SKILL_GROUPS) {
    const members = skills.filter((skill) => (skill.source ?? "configured") === group.source);
    if (members.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      pushLine(lines, lineColors, lineIndents, "", "gray", 0);
    }
    pushLine(lines, lineColors, lineIndents, `${group.label} · ${members.length}`, group.color, 0);
    for (const skill of members) {
      pushLine(
        lines,
        lineColors,
        lineIndents,
        `├ /${skill.name} · ${skillMetadata(skill)}`,
        "green",
        1,
      );
      pushLine(lines, lineColors, lineIndents, `└ ${skillDescription(skill)}`, "gray", 1);
    }
  }

  return {
    lineColors,
    lineIndents,
    message: lines.join("\n"),
  };
}

function skillDescription(skill: SlashCommandSkill): string {
  return skill.description?.replaceAll(/\s+/gu, " ").trim() || "Run configured Skill";
}

function skillMetadata(skill: SlashCommandSkill): string {
  if (skill.source === undefined) {
    return "configured";
  }
  return [`v${skill.version ?? "0.0.0-local"}`, skill.digest?.slice(0, 8)]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function pushLine(
  lines: string[],
  colors: SlashCommandLineColor[],
  indents: number[],
  line: string,
  color: SlashCommandLineColor,
  indent: number,
): void {
  lines.push(line);
  colors.push(color);
  indents.push(indent);
}
