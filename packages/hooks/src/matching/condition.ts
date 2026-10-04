import { HookMatcherError } from "../errors.js";
import type { JsonObject, JsonValue } from "../types.js";

const MAX_CONDITION_LENGTH = 2_048;
const TOOL_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const CANDIDATE_KEYS = new Set([
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
]);

export class HookCondition {
  public readonly pattern: string;
  public readonly toolName: string;
  private readonly argumentMatcher: RegExp;

  public constructor(condition: string) {
    const normalized = condition.trim();

    if (!normalized || normalized.length > MAX_CONDITION_LENGTH) {
      throw conditionError(
        normalized
          ? `Hook condition exceeds ${MAX_CONDITION_LENGTH} characters.`
          : "Hook condition is empty.",
      );
    }

    const openingIndex = normalized.indexOf("(");
    const closingIndex = normalized.lastIndexOf(")");

    if (
      openingIndex <= 0 ||
      closingIndex !== normalized.length - 1 ||
      normalized.indexOf("(", openingIndex + 1) !== -1
    ) {
      throw conditionError("Hook condition must use Tool(pattern) syntax.");
    }

    const toolName = normalized.slice(0, openingIndex).trim();
    const argumentPattern = normalized.slice(openingIndex + 1, closingIndex).trim() || "*";

    if (!TOOL_NAME_PATTERN.test(toolName)) {
      throw conditionError("Hook condition tool name is invalid.");
    }

    this.pattern = argumentPattern;
    this.toolName = toolName;
    this.argumentMatcher = compileGlob(argumentPattern);
  }

  public matches(toolName: string, input: JsonObject): boolean {
    if (toolName !== this.toolName) {
      return false;
    }

    if (this.pattern === "*") {
      return true;
    }

    return collectCandidates(input).some((candidate) => this.argumentMatcher.test(candidate));
  }
}

function collectCandidates(input: JsonObject): readonly string[] {
  const candidates = new Set<string>();

  for (const [key, value] of Object.entries(input)) {
    if (CANDIDATE_KEYS.has(key)) {
      collectText(value, candidates);
    }
  }

  const command = typeof input.command === "string" ? input.command : undefined;

  if (command !== undefined) {
    for (const segment of command.split(/(?:&&|\|\||[;\n])/u)) {
      const normalized = segment.trim();
      if (normalized) {
        candidates.add(normalized);
      }
    }
  }

  return [...candidates];
}

function collectText(value: JsonValue, candidates: Set<string>): void {
  if (typeof value === "string") {
    candidates.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, candidates);
    }
  }
}

function compileGlob(pattern: string): RegExp {
  let source = "^";

  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegExp(character);
    }
  }

  source += "$";
  return new RegExp(source, "u");
}

function escapeRegExp(value: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(value) ? `\\${value}` : value;
}

function conditionError(message: string): HookMatcherError {
  return new HookMatcherError("HOOK_MATCHER_INVALID", message);
}
