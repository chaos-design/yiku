const DEFAULT_CHARACTERS_PER_TOKEN = 4;

export interface ContextBudgetOptions {
  readonly charactersPerToken?: number | undefined;
  readonly compactAtContextRatio: number;
  readonly compactToContextRatio: number;
  readonly fallbackMaxCharacters: number;
}

export interface ContextBudgetInput {
  readonly contextWindow?: number | undefined;
  readonly historyCharacters: number;
  readonly peakInputTokens?: number | undefined;
}

export interface ContextBudgetDecision {
  readonly maxSummaryChars: number;
  readonly reason?: "characters" | "tokens" | undefined;
  readonly shouldCompact: boolean;
}

export class ContextBudget {
  private readonly charactersPerToken: number;

  public constructor(private readonly options: ContextBudgetOptions) {
    requireRatio(options.compactAtContextRatio, "compactAtContextRatio");
    requireRatio(options.compactToContextRatio, "compactToContextRatio");
    if (options.compactToContextRatio >= options.compactAtContextRatio) {
      throw new Error("compactToContextRatio must be less than compactAtContextRatio.");
    }
    requirePositiveInteger(options.fallbackMaxCharacters, "fallbackMaxCharacters");
    this.charactersPerToken = options.charactersPerToken ?? DEFAULT_CHARACTERS_PER_TOKEN;
    requirePositiveInteger(this.charactersPerToken, "charactersPerToken");
  }

  public evaluate(input: ContextBudgetInput): ContextBudgetDecision {
    if (input.contextWindow !== undefined && input.peakInputTokens !== undefined) {
      requirePositiveInteger(input.contextWindow, "contextWindow");
      const shouldCompact =
        input.peakInputTokens / input.contextWindow >= this.options.compactAtContextRatio;
      return {
        maxSummaryChars: Math.max(
          1,
          Math.floor(
            input.contextWindow * this.options.compactToContextRatio * this.charactersPerToken,
          ),
        ),
        ...(shouldCompact ? { reason: "tokens" as const } : {}),
        shouldCompact,
      };
    }

    const shouldCompact =
      input.historyCharacters >=
      this.options.fallbackMaxCharacters * this.options.compactAtContextRatio;
    return {
      maxSummaryChars: Math.max(
        1,
        Math.floor(this.options.fallbackMaxCharacters * this.options.compactToContextRatio),
      ),
      ...(shouldCompact ? { reason: "characters" as const } : {}),
      shouldCompact,
    };
  }
}

function requireRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
