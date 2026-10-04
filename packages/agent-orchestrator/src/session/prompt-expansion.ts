import { type HookDecision, HookError, type HookEventBase, type HookSession } from "@yiku/hooks";

export interface PromptExpansionOptions {
  readonly eventBase: HookEventBase<"UserPromptExpansion">;
  readonly hookSession?: HookSession | undefined;
}

export interface PromptExpansionResult {
  readonly additionalContext: readonly string[];
  readonly decision?: HookDecision | undefined;
  readonly prompt: string;
}

export class PromptExpansion {
  public constructor(private readonly options: PromptExpansionOptions) {}

  public async expand(
    commandName: string,
    prompt: string,
    commandArgs?: string,
  ): Promise<PromptExpansionResult> {
    if (this.options.hookSession === undefined) {
      return {
        additionalContext: [],
        prompt,
      };
    }

    const decision = await this.options.hookSession.dispatch({
      ...this.options.eventBase,
      ...(commandArgs !== undefined ? { command_args: commandArgs } : {}),
      command_name: commandName,
      hook_event_name: "UserPromptExpansion",
      prompt,
    });

    if (decision.action === "block" || decision.action === "stop") {
      throw new HookError(
        "HOOK_EXECUTION_FAILED",
        `Prompt expansion was blocked by Hook policy: ${decision.reasons.join("; ") || "blocked"}.`,
        { eventName: "UserPromptExpansion" },
      );
    }

    return {
      additionalContext: decision.additionalContext,
      decision,
      prompt: typeof decision.updatedValue === "string" ? decision.updatedValue : prompt,
    };
  }
}
