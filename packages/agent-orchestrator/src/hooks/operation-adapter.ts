import type { OperationEvent } from "@yiku/trajectory";
import type { Hook, HookContext } from "./types.js";

const DEFAULT_MAX_PENDING = 1_024;

export interface OperationHookDiagnostic {
  readonly code: "OPERATION_HOOK_FAILED" | "OPERATION_HOOK_QUEUE_FULL";
  readonly fatal: boolean;
  readonly hookName?: string | undefined;
  readonly message: string;
}

export interface OperationHookAdapterOptions {
  readonly maxConcurrency?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly onDiagnostic?: ((diagnostic: OperationHookDiagnostic) => void) | undefined;
}

interface PendingOperation {
  readonly context: HookContext;
  readonly event: OperationEvent;
}

/**
 * @deprecated Migrate observers to @yiku/hooks lifecycle callbacks.
 */
export class OperationHookAdapter {
  private active = 0;
  private readonly fatalErrors: unknown[] = [];
  private readonly maxConcurrency: number;
  private readonly maxPending: number;
  private readonly queue: PendingOperation[] = [];
  private readonly waiters = new Set<() => void>();

  public constructor(
    private readonly hooks: readonly Hook[],
    private readonly options: OperationHookAdapterOptions = {},
  ) {
    this.maxConcurrency = requirePositiveInteger(options.maxConcurrency ?? 1, "maxConcurrency");
    this.maxPending = requirePositiveInteger(
      options.maxPending ?? DEFAULT_MAX_PENDING,
      "maxPending",
    );
  }

  public enqueue(event: OperationEvent, context: HookContext = {}): void {
    if (this.hooks.length === 0) {
      return;
    }

    if (this.queue.length + this.active >= this.maxPending) {
      const error = new Error(
        `Legacy Operation Hook queue exceeded ${this.maxPending} pending operations.`,
      );
      const fatal = this.hooks.some((hook) => hook.fatal === true);
      this.diagnostic({
        code: "OPERATION_HOOK_QUEUE_FULL",
        fatal,
        message: error.message,
      });
      if (fatal) {
        this.fatalErrors.push(error);
      }
      return;
    }

    this.queue.push({ context, event });
    this.pump();
  }

  public async notify(event: OperationEvent, context: HookContext = {}): Promise<void> {
    this.enqueue(event, context);
    await this.flush();
  }

  public async flush(): Promise<void> {
    if (this.active > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }

    const fatalError = this.fatalErrors.shift();
    if (fatalError !== undefined) {
      throw fatalError;
    }
  }

  private pump(): void {
    while (this.active < this.maxConcurrency) {
      const operation = this.queue.shift();
      if (operation === undefined) {
        break;
      }

      this.active += 1;
      void this.execute(operation).finally(() => {
        this.active -= 1;
        this.pump();
        this.settleIfIdle();
      });
    }
  }

  private async execute(operation: PendingOperation): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.onOperation(operation.event, operation.context);
      } catch (error) {
        const diagnostic = {
          code: "OPERATION_HOOK_FAILED",
          fatal: hook.fatal === true,
          hookName: hook.name,
          message: error instanceof Error ? error.message : String(error),
        } as const;
        this.diagnostic(diagnostic);
        if (diagnostic.fatal) {
          this.fatalErrors.push(error);
        }
      }
    }
  }

  private settleIfIdle(): void {
    if (this.active > 0 || this.queue.length > 0) {
      return;
    }

    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.clear();
  }

  private diagnostic(diagnostic: OperationHookDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Operation Hook Adapter ${name} must be a positive integer.`);
  }
  return value;
}
