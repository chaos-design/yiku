import type { PromptRiskFinding, PromptSegment } from "./types.js";

const DEFAULT_MAX_PROMPT_CHARACTERS = 256 * 1024;
const DEFAULT_MAX_SEGMENT_CHARACTERS = 128 * 1024;
const DEFAULT_MAX_TOTAL_CONTEXT_CHARACTERS = 512 * 1024;

const RISK_PATTERNS: readonly {
  readonly code: PromptRiskFinding["code"];
  readonly pattern: RegExp;
}[] = [
  {
    code: "instruction-override",
    pattern:
      /\b(?:ignore|disregard|override|forget)\b[\s\S]{0,80}\b(?:previous|prior|system|developer|hidden)\b[\s\S]{0,40}\b(?:instruction|prompt|message)s?\b/iu,
  },
  {
    code: "instruction-override",
    pattern: /忽略[\s\S]{0,40}(?:之前|先前|系统|开发者|隐藏)[\s\S]{0,20}(?:指令|提示词|消息)/u,
  },
  {
    code: "prompt-exfiltration",
    pattern:
      /\b(?:reveal|show|print|repeat|expose|return)\b[\s\S]{0,80}\b(?:system|developer|hidden|internal)\b[\s\S]{0,40}\b(?:instruction|prompt|message)s?\b/iu,
  },
  {
    code: "prompt-exfiltration",
    pattern:
      /(?:显示|泄露|输出|重复)[\s\S]{0,40}(?:系统|开发者|隐藏|内部)[\s\S]{0,20}(?:指令|提示词|消息)/u,
  },
  {
    code: "role-reassignment",
    pattern: /\b(?:you are now|act as|new role|switch roles?|become)\b/iu,
  },
  {
    code: "role-reassignment",
    pattern: /(?:你现在是|扮演|切换角色|成为新的)/u,
  },
  {
    code: "tool-coercion",
    pattern:
      /\b(?:must|immediately|silently)\b[\s\S]{0,80}\b(?:call|invoke|run|execute|use)\b[\s\S]{0,40}\b(?:tool|command|shell|terminal)\b/iu,
  },
  {
    code: "tool-coercion",
    pattern: /(?:必须|立即|静默)[\s\S]{0,40}(?:调用|运行|执行|使用)[\s\S]{0,20}(?:工具|命令|终端)/u,
  },
];

export type PromptGuardErrorCode =
  | "PROMPT_CONTROL_CHARACTER"
  | "PROMPT_EMPTY"
  | "PROMPT_TOO_LARGE"
  | "PROMPT_CONTEXT_TOO_LARGE"
  | "PROMPT_SEGMENT_TOO_LARGE";

export class PromptGuardError extends Error {
  public override readonly name = "PromptGuardError";

  public constructor(
    public readonly code: PromptGuardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PromptGuardOptions {
  readonly maxPromptCharacters?: number | undefined;
  readonly maxSegmentCharacters?: number | undefined;
  readonly maxTotalContextCharacters?: number | undefined;
}

export class PromptGuard {
  private readonly maxPromptCharacters: number;
  private readonly maxSegmentCharacters: number;
  private readonly maxTotalContextCharacters: number;

  public constructor(options: PromptGuardOptions = {}) {
    this.maxPromptCharacters = requirePositiveInteger(
      options.maxPromptCharacters ?? DEFAULT_MAX_PROMPT_CHARACTERS,
      "Prompt character limit",
    );
    this.maxSegmentCharacters = requirePositiveInteger(
      options.maxSegmentCharacters ?? DEFAULT_MAX_SEGMENT_CHARACTERS,
      "Prompt segment character limit",
    );
    this.maxTotalContextCharacters = requirePositiveInteger(
      options.maxTotalContextCharacters ?? DEFAULT_MAX_TOTAL_CONTEXT_CHARACTERS,
      "Prompt context character limit",
    );
  }

  public validateUserPrompt(value: string): string {
    const normalized = normalizeLineEndings(value).trim();
    if (!normalized) {
      throw new PromptGuardError("PROMPT_EMPTY", "Agent Session prompt must be non-empty.");
    }
    this.requireSafeCharacters(normalized, "Agent Session prompt");
    if (normalized.length > this.maxPromptCharacters) {
      throw new PromptGuardError(
        "PROMPT_TOO_LARGE",
        `Agent Session prompt exceeds ${this.maxPromptCharacters} characters.`,
      );
    }
    return normalized;
  }

  public validateSegments(segments: readonly PromptSegment[]): readonly PromptSegment[] {
    let totalCharacters = 0;
    const validated = segments.map((segment) => {
      const content = normalizeLineEndings(segment.content).trim();
      if (!content) {
        return undefined;
      }
      this.requireSafeCharacters(content, `Prompt ${segment.kind} segment`);
      if (content.length > this.maxSegmentCharacters) {
        throw new PromptGuardError(
          "PROMPT_SEGMENT_TOO_LARGE",
          `Prompt ${segment.kind} segment exceeds ${this.maxSegmentCharacters} characters.`,
        );
      }
      totalCharacters += content.length;
      return Object.freeze({
        ...segment,
        content,
      });
    });
    if (totalCharacters > this.maxTotalContextCharacters) {
      throw new PromptGuardError(
        "PROMPT_CONTEXT_TOO_LARGE",
        `Prompt context exceeds ${this.maxTotalContextCharacters} characters.`,
      );
    }
    return Object.freeze(
      validated.filter((segment): segment is PromptSegment => segment !== undefined),
    );
  }

  public inspect(segments: readonly PromptSegment[]): readonly PromptRiskFinding[] {
    const findings: PromptRiskFinding[] = [];
    for (const [segmentIndex, segment] of segments.entries()) {
      for (const risk of RISK_PATTERNS) {
        if (!risk.pattern.test(segment.content)) {
          continue;
        }
        findings.push(
          Object.freeze({
            code: risk.code,
            segmentIndex,
            severity: segment.trust === "untrusted" ? "warning" : "info",
            source: segment.source,
            ...(segment.sourceId !== undefined ? { sourceId: segment.sourceId } : {}),
            trust: segment.trust,
          }),
        );
      }
    }
    return Object.freeze(findings);
  }

  private requireSafeCharacters(value: string, label: string): void {
    if (hasDisallowedControlCharacter(value)) {
      throw new PromptGuardError(
        "PROMPT_CONTROL_CHARACTER",
        `${label} contains unsupported control characters.`,
      );
    }
  }
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
