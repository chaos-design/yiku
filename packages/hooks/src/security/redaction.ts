import { HookSecurityError } from "../errors.js";
import type { JsonValue } from "../types.js";

export interface HookRedactionRule {
  readonly name: string;
  redact(value: string): string;
}

export class PatternHookRedactionRule implements HookRedactionRule {
  public constructor(
    public readonly name: string,
    private readonly pattern: RegExp,
    private readonly replacement = "[REDACTED]",
  ) {}

  public redact(value: string): string {
    return value.replace(this.pattern, this.replacement);
  }
}

export const BUILT_IN_HOOK_REDACTION_RULES: readonly HookRedactionRule[] = Object.freeze([
  new PatternHookRedactionRule(
    "private-key",
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
  ),
  new PatternHookRedactionRule("bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu),
  new PatternHookRedactionRule("openai-key", /\bsk-[A-Za-z0-9_-]{16,}\b/gu),
  new PatternHookRedactionRule("github-token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu),
  new PatternHookRedactionRule(
    "generic-secret",
    /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"',;]+/giu,
  ),
]);

const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|password|secret|token)/iu;

export class HookRedactor {
  private readonly rules: readonly HookRedactionRule[];

  public constructor(customRules: readonly HookRedactionRule[] = []) {
    this.rules = Object.freeze([...BUILT_IN_HOOK_REDACTION_RULES, ...customRules]);
  }

  public redactText(value: string): string {
    let redacted = value;

    for (const rule of this.rules) {
      try {
        redacted = rule.redact(redacted);
      } catch (error) {
        throw new HookSecurityError(
          "HOOK_SECURITY_REJECTED",
          `Hook redaction rule failed: ${rule.name}.`,
          { cause: error },
        );
      }
    }

    return redacted;
  }

  public redactJson(value: JsonValue): JsonValue {
    if (typeof value === "string") {
      return this.redactText(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactJson(item));
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : this.redactJson(child),
      ]),
    );
  }
}
