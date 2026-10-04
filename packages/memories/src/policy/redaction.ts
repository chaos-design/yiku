import { MemoryValidationError } from "../errors.js";
import type { MemoryRedactor } from "../types.js";

const REDACTED = "[REDACTED]";

export interface RedactionResult {
  readonly content: string;
  readonly redactors: readonly string[];
}

export class PatternMemoryRedactor implements MemoryRedactor {
  public constructor(
    public readonly name: string,
    private readonly pattern: RegExp,
  ) {}

  public redact(content: string): string {
    return content.replace(this.pattern, REDACTED);
  }
}

export const BUILT_IN_MEMORY_REDACTORS: readonly MemoryRedactor[] = Object.freeze([
  new PatternMemoryRedactor(
    "private-key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  ),
  new PatternMemoryRedactor("bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu),
  new PatternMemoryRedactor("openai-key", /\bsk-[A-Za-z0-9_-]{16,}\b/gu),
  new PatternMemoryRedactor("github-token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu),
  new PatternMemoryRedactor(
    "credential-assignment",
    /\b(api[_-]?key|access[_-]?token|password|secret|token)\s*=\s*("[^"]+"|'[^']+'|[^\s,;]+)/giu,
  ),
]);

export function redactMemoryContent(
  content: string,
  customRedactors: readonly MemoryRedactor[] = [],
): RedactionResult {
  const changed: string[] = [];
  let current = content;

  for (const redactor of [...BUILT_IN_MEMORY_REDACTORS, ...customRedactors]) {
    try {
      const next = redactor.redact(current);

      if (next !== current) {
        changed.push(redactor.name);
        current = next;
      }
    } catch (error) {
      throw new MemoryValidationError(
        "MEMORY_REDACTION_FAILED",
        `Memory redactor failed: ${redactor.name}.`,
        { cause: error },
      );
    }
  }

  return {
    content: current,
    redactors: changed,
  };
}
