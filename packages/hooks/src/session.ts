import type { HookDecisionInput } from "./decision.js";
import type { HookDispatchState, HookEngine } from "./engine.js";
import { HookError } from "./errors.js";
import type { HookDecision, HookDiagnostic, HookEvent, HookEventName } from "./types.js";

const REPEATABLE_BLOCK_EVENTS = new Set<HookEventName>([
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TeammateIdle",
]);

export interface HookSessionOptions {
  readonly depth?: number | undefined;
  readonly engine: HookEngine;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  readonly parentInvocationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class HookSession {
  private readonly background = new Set<Promise<void>>();
  private readonly backgroundMailbox: HookDecisionInput[] = [];
  private readonly controller = new AbortController();
  private readonly depth: number;
  private readonly engine: HookEngine;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly once = new Set<string>();
  private readonly parentAbort: () => void;
  private readonly parentInvocationId?: string | undefined;
  private readonly parentSignal?: AbortSignal | undefined;
  private readonly repeatBlocks = new Map<HookEventName, number>();
  private closed = false;

  public constructor(options: HookSessionOptions) {
    this.depth = options.depth ?? 0;
    this.engine = options.engine;
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    this.parentInvocationId = options.parentInvocationId;
    this.parentSignal = options.signal;
    this.parentAbort = () => this.controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", this.parentAbort, { once: true });
    if (options.signal?.aborted === true) {
      this.parentAbort();
    }
  }

  public async dispatch(event: HookEvent): Promise<HookDecision> {
    this.assertOpen();
    const decision = await this.engine.dispatch(event, this.dispatchState());
    return this.applyRepeatBlockLimit(event.hook_event_name, decision);
  }

  public drainBackgroundDecisions(): HookDecision {
    const inputs = this.backgroundMailbox.splice(0);
    return this.engine.aggregate(inputs);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.background.size > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.background]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.controller.abort(
              new HookError("HOOK_ABORTED", "Hook Session background close deadline exceeded."),
            );
            resolve();
          }, this.engine.limits.backgroundCloseTimeoutMs);
        }),
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    this.controller.abort(new HookError("HOOK_ABORTED", "Hook Session closed."));
    this.parentSignal?.removeEventListener("abort", this.parentAbort);
  }

  private dispatchState(): HookDispatchState {
    return {
      depth: this.depth,
      enqueueBackground: (task) => this.enqueueBackground(task),
      environment: this.environment,
      hasRunOnce: (hookId) => this.once.has(hookId),
      markOnce: (hookId) => this.once.add(hookId),
      ...(this.parentInvocationId !== undefined
        ? { parentInvocationId: this.parentInvocationId }
        : {}),
      signal: this.controller.signal,
    };
  }

  private enqueueBackground(task: Promise<HookDecisionInput>): void {
    const tracked = task
      .then((input) => {
        this.backgroundMailbox.push(input);
      })
      .catch(() => {
        // Engine execution converts failures to HookExecutionResult before they reach the mailbox.
      })
      .finally(() => {
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }

  private applyRepeatBlockLimit(eventName: HookEventName, decision: HookDecision): HookDecision {
    if (
      !REPEATABLE_BLOCK_EVENTS.has(eventName) ||
      (decision.action !== "block" && decision.action !== "stop")
    ) {
      return decision;
    }

    const count = (this.repeatBlocks.get(eventName) ?? 0) + 1;
    this.repeatBlocks.set(eventName, count);

    if (count <= this.engine.limits.maxStopBlocks) {
      return decision;
    }

    const diagnostic: HookDiagnostic = {
      code: "HOOK_BLOCK_LIMIT_REACHED",
      message: `${eventName} Hook block limit was reached.`,
      severity: "warning",
    };
    return Object.freeze({
      ...decision,
      action: "no-op",
      diagnostics: Object.freeze([...decision.diagnostics, diagnostic]),
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HookError("HOOK_ABORTED", "Hook Session is closed.");
    }
  }
}
