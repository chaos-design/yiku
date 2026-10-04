import { createBuiltinCommands } from "./builtin/index.js";
import type {
  SlashCommand,
  SlashCommandAgent,
  SlashCommandArguments,
  SlashCommandResolution,
  SlashCommandSkill,
  SlashCommandSubmitResult,
} from "./types.js";

const MAX_CHAINED_SKILLS = 6;

export const SLASH_COMMAND_GROUPS = [
  "GENERAL",
  "SESSION",
  "STATUS",
  "RUNTIME",
  "WORKFLOWS",
  "AGENTS",
  "SKILLS",
] as const;

export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

const SLASH_COMMAND_GROUP_ORDER = new Map(
  SLASH_COMMAND_GROUPS.map((group, index) => [group, index]),
);

export interface SlashCommandQuery {
  readonly endIndex: number;
  readonly query: string;
  readonly startIndex: number;
}

export interface ApplySlashCommandResult {
  readonly cursorIndex: number;
  readonly value: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = createBuiltinCommands();

export function getSlashCommandGroup(command: SlashCommand): SlashCommandGroup {
  if (command.source === "agent" || command.name === "agent-new" || command.name === "agents") {
    return "AGENTS";
  }
  if (command.source === "skill" || command.name === "skills") {
    return "SKILLS";
  }
  if (command.name === "review" || command.name.startsWith("spec:")) {
    return "WORKFLOWS";
  }

  switch (command.name) {
    case "resume":
    case "rename":
    case "branch":
    case "rewind":
    case "copy":
    case "export":
      return "SESSION";
    case "status":
    case "context":
    case "usage":
    case "tasks":
      return "STATUS";
    case "compact":
    case "init":
    case "doctor":
    case "memory":
    case "hooks":
    case "model":
    case "mcp":
    case "output-style":
      return "RUNTIME";
    default:
      return "GENERAL";
  }
}

export function createSlashCommands(
  skills: readonly SlashCommandSkill[],
  agents: readonly SlashCommandAgent[] = [],
): readonly SlashCommand[] {
  const reservedNames = new Set(
    SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  );
  const agentCommands = agents
    .filter((agent) => isCommandName(agent.name))
    .map(
      (agent): SlashCommand => ({
        description: agent.description,
        execution: "idle",
        execute: async (context, arguments_) => {
          const prompt = arguments_.values.join(" ").trim() || agent.deliverable;
          const result = await context.runAgent(agent.id, prompt);
          return {
            kind: "success",
            message: [
              result.finalOutput,
              "",
              `Agent: ${result.agentId}`,
              `Task: ${result.taskId}`,
              `Status: ${result.status}`,
            ].join("\n"),
            title: `Agent · ${agent.name}`,
          };
        },
        kind: "local",
        name: `agent:${agent.name}`,
        progressLabel: `Running Agent ${agent.name}`,
        source: "agent",
      }),
    );
  const skillCommands = skills
    .filter((skill) => isCommandName(skill.name) && !reservedNames.has(skill.name))
    .map(
      (skill): SlashCommand => ({
        description: skill.description ?? "Run configured Skill",
        execution: "idle",
        getSubmission: (_context, arguments_) =>
          skillSubmission([skill.name], arguments_, `/${skill.name}${withSpace(arguments_.raw)}`),
        kind: "prompt",
        name: skill.name,
        source: "skill",
      }),
    );

  return Object.freeze([...SLASH_COMMANDS, ...agentCommands, ...skillCommands]);
}

export function resolveSlashCommand(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommandResolution {
  const trimmedInput = input.trim();

  if (!trimmedInput.startsWith("/")) {
    return { kind: "not-slash" };
  }

  const commandToken = trimmedInput.slice(1);
  const separatorIndex = commandToken.search(/\s/u);
  const commandName =
    separatorIndex < 0 ? commandToken : commandToken.slice(0, separatorIndex).trim();
  const command = commands.find(
    (candidate) => candidate.name === commandName || candidate.aliases?.includes(commandName),
  );

  if (!command) {
    return {
      commandName,
      kind: "unknown",
    };
  }

  if (command.source === "skill") {
    return resolveSkillChain(trimmedInput, commands);
  }

  let arguments_: SlashCommandArguments;
  try {
    arguments_ = parseSlashCommandArguments(
      separatorIndex < 0 ? "" : commandToken.slice(separatorIndex).trim(),
    );
  } catch (error) {
    return {
      commandName,
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    arguments: arguments_,
    command,
    kind: "found",
  };
}

export function parseSlashCommandArguments(raw: string): SlashCommandArguments {
  const values: string[] = [];
  let current = "";
  let escaped = false;
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (const character of raw) {
    if (escaped) {
      current += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      if (quote === undefined) {
        quote = character;
        tokenStarted = true;
        continue;
      }
      if (quote === character) {
        quote = undefined;
        continue;
      }
    }

    if (quote === undefined && isWhitespace(character)) {
      if (tokenStarted) {
        values.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaped || quote !== undefined) {
    throw new Error("Slash command arguments contain an unfinished quote or escape.");
  }
  if (tokenStarted) {
    values.push(current);
  }

  return {
    raw,
    values: Object.freeze(values),
  };
}

export function getSlashCommandSuggestions(
  input: string,
  cursorIndex = input.length,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommand[] {
  const completion = getSlashCommandQuery(input, cursorIndex);

  if (!completion) {
    return [];
  }

  const { query } = completion;
  const matches = query
    ? commands.filter(
        (command) =>
          command.name.startsWith(query) ||
          Boolean(command.aliases?.some((alias) => alias.startsWith(query))),
      )
    : commands;

  return matches.toSorted(
    (left, right) =>
      (SLASH_COMMAND_GROUP_ORDER.get(getSlashCommandGroup(left)) ?? 0) -
      (SLASH_COMMAND_GROUP_ORDER.get(getSlashCommandGroup(right)) ?? 0),
  );
}

function resolveSkillChain(
  input: string,
  commands: readonly SlashCommand[],
): SlashCommandResolution {
  const skillNames: string[] = [];
  let remaining = input;

  while (skillNames.length < MAX_CHAINED_SKILLS) {
    const match = /^\/([^\s]+)(?=\s|$)/u.exec(remaining);
    const name = match?.[1];
    const command =
      name === undefined
        ? undefined
        : commands.find((candidate) => candidate.source === "skill" && candidate.name === name);

    if (match === null || command === undefined) {
      break;
    }

    skillNames.push(command.name);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  const nextName = /^\/([^\s]+)(?=\s|$)/u.exec(remaining)?.[1];
  if (
    skillNames.length === MAX_CHAINED_SKILLS &&
    nextName !== undefined &&
    commands.some((command) => command.source === "skill" && command.name === nextName)
  ) {
    return {
      commandName: skillNames[0] ?? "",
      kind: "invalid",
      message: `At most ${MAX_CHAINED_SKILLS} Skills can be chained.`,
    };
  }

  let arguments_: SlashCommandArguments;
  try {
    arguments_ = parseSlashCommandArguments(remaining);
  } catch (error) {
    return {
      commandName: skillNames[0] ?? "",
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    arguments: arguments_,
    command: {
      description: "Run configured Skills",
      execution: "idle",
      getSubmission: () => skillSubmission(skillNames, arguments_, input),
      kind: "prompt",
      name: skillNames.join(" "),
      source: "skill",
    },
    kind: "found",
  };
}

function skillSubmission(
  skillNames: readonly string[],
  arguments_: SlashCommandArguments,
  displayPrompt: string,
): SlashCommandSubmitResult {
  const commandArgs = arguments_.raw.trim();
  return {
    activatedSkills: Object.freeze([...skillNames]),
    ...(commandArgs ? { commandArgs } : {}),
    commandName: skillNames.join(" "),
    displayPrompt,
    kind: "submit" as const,
    prompt: commandArgs || `Run the activated Skill${skillNames.length === 1 ? "" : "s"}.`,
  };
}

function isCommandName(name: string): boolean {
  return Boolean(name) && !/[\s/]/u.test(name);
}

function withSpace(value: string): string {
  return value ? ` ${value}` : "";
}

export function getSlashCommandQuery(
  input: string,
  cursorIndex: number,
): SlashCommandQuery | undefined {
  const resolvedCursorIndex = Math.max(0, Math.min(cursorIndex, input.length));
  let startIndex = resolvedCursorIndex;

  while (startIndex > 0 && !isWhitespace(input.charAt(startIndex - 1))) {
    startIndex -= 1;
  }

  if (input.charAt(startIndex) !== "/") {
    return undefined;
  }

  let endIndex = resolvedCursorIndex;

  while (endIndex < input.length && !isWhitespace(input.charAt(endIndex))) {
    endIndex += 1;
  }

  return {
    endIndex,
    query: input.slice(startIndex + 1, resolvedCursorIndex),
    startIndex,
  };
}

export function applySlashCommandCompletion(
  input: string,
  completion: SlashCommandQuery,
  commandName: string,
): ApplySlashCommandResult {
  const command = `/${commandName}`;
  const suffix = input.slice(completion.endIndex);
  const separator = suffix && isWhitespace(suffix.charAt(0)) ? "" : " ";
  const completedPrefix = `${input.slice(0, completion.startIndex)}${command}${separator}`;

  return {
    cursorIndex: completedPrefix.length,
    value: `${completedPrefix}${suffix}`,
  };
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
