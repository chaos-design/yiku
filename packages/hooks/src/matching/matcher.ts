import { HookMatcherError } from "../errors.js";

const MAX_MATCHER_LENGTH = 1_024;
const EXACT_MATCHER_PATTERN = /^[\p{L}\p{N}_\-\s,|]*$/u;
const UNSAFE_REGEXP_PATTERN = /(?:\([^)]*[+*][^)]*\))[+*{]|\.\*[+*{]/u;

export type HookMatcherMode = "all" | "exact" | "regexp";

export class HookMatcher {
  public readonly mode: HookMatcherMode;
  public readonly pattern: string;
  private readonly exactValues: ReadonlySet<string>;
  private readonly regexp?: RegExp | undefined;

  public constructor(pattern?: string | undefined) {
    const normalized = pattern?.trim() ?? "";
    this.pattern = normalized;

    if (!normalized || normalized === "*") {
      this.mode = "all";
      this.exactValues = new Set();
      return;
    }

    if (normalized.length > MAX_MATCHER_LENGTH) {
      throw matcherError(`Hook matcher exceeds ${MAX_MATCHER_LENGTH} characters.`);
    }

    if (EXACT_MATCHER_PATTERN.test(normalized)) {
      const values = normalized
        .split(/[|,]/u)
        .map((value) => value.trim())
        .filter(Boolean);

      if (values.length === 0) {
        this.mode = "all";
        this.exactValues = new Set();
        return;
      }

      this.mode = "exact";
      this.exactValues = new Set(values);
      return;
    }

    if (UNSAFE_REGEXP_PATTERN.test(normalized)) {
      throw matcherError("Hook matcher contains a potentially unsafe nested quantifier.");
    }

    try {
      this.regexp = new RegExp(normalized, "u");
    } catch (error) {
      throw new HookMatcherError("HOOK_MATCHER_INVALID", "Hook matcher is not a valid RegExp.", {
        cause: error,
      });
    }

    this.mode = "regexp";
    this.exactValues = new Set();
  }

  public matches(value: string): boolean {
    switch (this.mode) {
      case "all":
        return true;
      case "exact":
        return this.exactValues.has(value);
      case "regexp":
        return this.regexp?.test(value) ?? false;
    }
  }
}

function matcherError(message: string): HookMatcherError {
  return new HookMatcherError("HOOK_MATCHER_INVALID", message);
}
