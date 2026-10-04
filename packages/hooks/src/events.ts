import type {
  HookEventName,
  HookExecutionStatus,
  HookExecutorType,
  HookSourceType,
} from "./types.js";

export type HookOperation = "dispatch" | "execute" | "load" | "trust";
export type HookOperationPhase = "end" | "error" | "start";

export interface HookOperationEvent {
  readonly code?: string | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly durationMs?: number | undefined;
  readonly endedAt?: string | undefined;
  readonly eventName?: HookEventName | undefined;
  readonly executorType?: HookExecutorType | undefined;
  readonly hookId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly operation: HookOperation;
  readonly operationId: string;
  readonly outcome?: HookExecutionStatus | undefined;
  readonly parentInvocationId?: string | undefined;
  readonly phase: HookOperationPhase;
  readonly sourceType?: HookSourceType | undefined;
  readonly startedAt: string;
  readonly truncatedBytes?: number | undefined;
}

export type HookEventHandler = (event: HookOperationEvent) => void;

export class HookEvents {
  public constructor(private readonly handler?: HookEventHandler | undefined) {}

  public emit(event: HookOperationEvent): void {
    try {
      this.handler?.(event);
    } catch {
      // An audit observer cannot recursively fail the Hook operation it observes.
    }
  }
}
