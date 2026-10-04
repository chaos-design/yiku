import { type HookDecision, HookError, type HookEventBase, type HookSession } from "@yiku/hooks";
import type { SessionHistory, SessionHistoryEntry } from "./history.js";

export interface ContextSummaryInput {
  readonly customInstructions?: string | undefined;
  readonly entries: readonly SessionHistoryEntry[];
  readonly maxChars: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ContextSummarizer {
  summarize(input: ContextSummaryInput): Promise<string>;
}

export interface ContextCompactorOptions {
  readonly eventBase: HookEventBase<"PreCompact">;
  readonly history: SessionHistory;
  readonly hookSession?: HookSession | undefined;
  readonly maxSummaryChars?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly summarizer: ContextSummarizer;
}

export interface ContextCompactionResult {
  readonly postDecision?: HookDecision | undefined;
  readonly preDecision?: HookDecision | undefined;
  readonly summary: string;
}

export class ContextCompactor {
  private readonly maxSummaryChars: number;

  public constructor(private readonly options: ContextCompactorOptions) {
    this.maxSummaryChars = options.maxSummaryChars ?? 8_000;
  }

  public async compact(
    trigger: "auto" | "manual",
    customInstructions?: string,
  ): Promise<ContextCompactionResult> {
    const preDecision =
      this.options.hookSession === undefined
        ? undefined
        : await this.options.hookSession.dispatch({
            ...this.options.eventBase,
            ...(customInstructions !== undefined
              ? { custom_instructions: customInstructions }
              : {}),
            hook_event_name: "PreCompact",
            trigger,
          });

    if (preDecision?.action === "block" || preDecision?.action === "stop") {
      throw new HookError(
        "HOOK_EXECUTION_FAILED",
        `Context compaction was blocked by Hook policy: ${preDecision.reasons.join("; ") || "blocked"}.`,
        { eventName: "PreCompact" },
      );
    }

    const combinedInstructions = [
      customInstructions?.trim(),
      ...(preDecision?.additionalContext ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const summary = (
      await this.options.summarizer.summarize({
        ...(combinedInstructions ? { customInstructions: combinedInstructions } : {}),
        entries: this.options.history.list(),
        maxChars: this.maxSummaryChars,
        ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      })
    ).trim();

    if (!summary) {
      throw new Error("Context summarizer returned an empty summary.");
    }
    if (summary.length > this.maxSummaryChars) {
      throw new Error(`Context summary exceeds ${this.maxSummaryChars} characters.`);
    }

    this.options.history.replace([{ content: summary, role: "assistant" }]);
    const postDecision =
      this.options.hookSession === undefined
        ? undefined
        : await this.options.hookSession.dispatch({
            ...this.options.eventBase,
            compact_summary: summary,
            hook_event_name: "PostCompact",
            trigger,
          });

    for (const context of postDecision?.additionalContext ?? []) {
      this.options.history.append("user", context);
    }

    return {
      ...(postDecision !== undefined ? { postDecision } : {}),
      ...(preDecision !== undefined ? { preDecision } : {}),
      summary,
    };
  }
}
