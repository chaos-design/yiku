import type { HookDecision, HookEventBase, HookSession } from "@yiku/hooks";

export interface MessageDisplayOptions {
  readonly eventBase: HookEventBase<"MessageDisplay">;
  readonly hookSession?: HookSession | undefined;
}

export interface MessageDisplayResult {
  readonly decision?: HookDecision | undefined;
  readonly message?: string | undefined;
}

export class MessageDisplay {
  public constructor(private readonly options: MessageDisplayOptions) {}

  public async present(message: string): Promise<MessageDisplayResult> {
    if (this.options.hookSession === undefined) {
      return { message };
    }

    const decision = await this.options.hookSession.dispatch({
      ...this.options.eventBase,
      hook_event_name: "MessageDisplay",
      message,
    });

    if (decision.suppressOutput) {
      return { decision };
    }

    return {
      decision,
      message: typeof decision.updatedValue === "string" ? decision.updatedValue : message,
    };
  }
}
