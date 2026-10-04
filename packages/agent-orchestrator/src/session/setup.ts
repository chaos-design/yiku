import { type HookDecision, HookError, type HookEventBase, type HookSession } from "@yiku/hooks";

export interface SetupRuntimeOptions {
  readonly eventBase: HookEventBase<"Setup">;
  readonly hookSession?: HookSession | undefined;
}

export class SetupRuntime {
  public constructor(private readonly options: SetupRuntimeOptions) {}

  public async run<T>(
    trigger: "init" | "maintenance",
    operation: () => Promise<T>,
  ): Promise<{ readonly decision?: HookDecision | undefined; readonly result: T }> {
    const decision =
      this.options.hookSession === undefined
        ? undefined
        : await this.options.hookSession.dispatch({
            ...this.options.eventBase,
            hook_event_name: "Setup",
            trigger,
          });

    if (decision?.action === "block" || decision?.action === "stop") {
      throw new HookError(
        "HOOK_EXECUTION_FAILED",
        `Setup was blocked by Hook policy: ${decision.reasons.join("; ") || "blocked"}.`,
        { eventName: "Setup" },
      );
    }

    return {
      ...(decision !== undefined ? { decision } : {}),
      result: await operation(),
    };
  }
}
