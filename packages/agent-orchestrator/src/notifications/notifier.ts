import type { HookDecision, HookEventBase, HookSession, NotificationHookEvent } from "@yiku/hooks";

export interface NotificationMessage {
  readonly message: string;
  readonly title?: string | undefined;
  readonly type: NotificationHookEvent["notification_type"];
}

export interface NotifierOptions {
  readonly eventBase: HookEventBase<"Notification">;
  readonly hookSession?: HookSession | undefined;
  readonly sink: (notification: NotificationMessage) => Promise<void> | void;
}

export class Notifier {
  public constructor(private readonly options: NotifierOptions) {}

  public async notify(notification: NotificationMessage): Promise<HookDecision | undefined> {
    const decision = await this.options.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "Notification",
      message: notification.message,
      notification_type: notification.type,
      ...(notification.title !== undefined ? { title: notification.title } : {}),
    });

    if (decision?.suppressOutput !== true) {
      await this.options.sink(notification);
    }

    return decision;
  }
}
