import { basename } from "node:path";
import { type ParseEntry, parse } from "shell-quote";
import type { ParsedShellCommand, ShellCommandDetails } from "./terminal-types.js";

interface DynamicShellValue {
  readonly key: string;
  readonly type: "dynamic";
}

type RedirectionTarget = "input" | "output";

export function parseShellCommand(command: string): ParsedShellCommand {
  if (!hasBalancedShellQuotes(command)) {
    return invalidShellCommand();
  }

  let tokens: readonly (DynamicShellValue | ParseEntry)[];
  try {
    tokens = parse<DynamicShellValue>(command, (key) => ({
      key,
      type: "dynamic",
    }));
  } catch {
    return invalidShellCommand();
  }

  const outputRedirectionTargets: string[] = [];
  const redirectionTargets: string[] = [];
  const segments: string[][] = [];
  let current: string[] = [];
  let complex = false;
  let dynamic = false;
  let expectedRedirectionTarget: RedirectionTarget | undefined;
  let hasComplexOperator = false;

  const appendValue = (value: string) => {
    if (expectedRedirectionTarget === undefined) {
      current.push(value);
      return;
    }
    redirectionTargets.push(value);
    if (expectedRedirectionTarget === "output") {
      outputRedirectionTargets.push(value);
    }
    expectedRedirectionTarget = undefined;
  };
  const flush = () => {
    if (current.length > 0) {
      segments.push(current);
    }
    current = [];
  };

  for (const token of tokens) {
    if (typeof token === "string") {
      appendValue(token);
      continue;
    }
    if (isDynamicShellValue(token)) {
      dynamic = true;
      appendValue(`$${token.key || "(substitution)"}`);
      continue;
    }
    if ("comment" in token) {
      break;
    }
    if (token.op === "glob") {
      current.push(token.pattern);
      continue;
    }
    if (isRedirectionOperator(token.op)) {
      complex = true;
      expectedRedirectionTarget = isOutputRedirectionOperator(token.op) ? "output" : "input";
      continue;
    }
    flush();
    if (![";", "&&", "||", ";;"].includes(token.op)) {
      complex = true;
      hasComplexOperator = true;
    }
  }
  flush();

  return {
    complex,
    dynamic,
    hasComplexOperator,
    outputRedirectionTargets,
    redirectionTargets,
    segments,
    valid: expectedRedirectionTarget === undefined && segments.length > 0,
  };
}

export function commandDetails(words: readonly string[]): ShellCommandDetails | undefined {
  let index = 0;

  while (/^[A-Za-z_]\w*=/.test(words[index] ?? "")) {
    index += 1;
  }
  while (words[index] === "command" || words[index] === "builtin") {
    index += 1;
  }
  if (words[index] === "env") {
    index += 1;
    while (/^(?:-|[A-Za-z_]\w*=)/.test(words[index] ?? "")) {
      index += 1;
    }
  }

  const executableWord = words[index];
  if (executableWord === undefined) {
    return undefined;
  }

  return {
    executable: basename(executableWord).toLowerCase(),
    words: words.slice(index + 1),
  };
}

export function hasCommandFlag(
  words: readonly string[],
  shortFlag: string,
  longFlag: string,
): boolean {
  return words.some(
    (word) =>
      word === `--${longFlag}` ||
      (word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes(shortFlag)),
  );
}

function invalidShellCommand(): ParsedShellCommand {
  return {
    complex: true,
    dynamic: false,
    hasComplexOperator: false,
    outputRedirectionTargets: [],
    redirectionTargets: [],
    segments: [],
    valid: false,
  };
}

function hasBalancedShellQuotes(command: string): boolean {
  let escaped = false;
  let quote: "'" | '"' | undefined;

  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
    }
  }

  return !escaped && quote === undefined;
}

function isDynamicShellValue(value: object): value is DynamicShellValue {
  return "type" in value && value.type === "dynamic";
}

function isRedirectionOperator(operator: string): boolean {
  return ["<", ">", ">>", ">&", "<&", "<<<"].includes(operator);
}

function isOutputRedirectionOperator(operator: string): boolean {
  return [">", ">>", ">&"].includes(operator);
}
