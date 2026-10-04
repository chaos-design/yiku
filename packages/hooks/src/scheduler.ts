import { HookError, HookTimeoutError } from "./errors.js";

export type HookScheduledResult<TResult> =
  | {
      readonly index: number;
      readonly status: "fulfilled";
      readonly value: TResult;
    }
  | {
      readonly index: number;
      readonly reason: unknown;
      readonly status: "rejected";
    };

export interface HookScheduleOptions {
  readonly deadline: number;
  readonly maxConcurrency: number;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class HookScheduler {
  public async run<TItem, TResult>(
    items: readonly TItem[],
    worker: (item: TItem, index: number, signal: AbortSignal) => Promise<TResult>,
    options: HookScheduleOptions,
  ): Promise<readonly HookScheduledResult<TResult>[]> {
    if (items.length === 0) {
      return [];
    }

    const now = options.now ?? Date.now;
    const controller = new AbortController();
    const results: Array<HookScheduledResult<TResult> | undefined> = new Array(items.length);
    const concurrency = Math.max(1, Math.min(options.maxConcurrency, items.length));
    let nextIndex = 0;
    let timedOut = false;
    const abortFromParent = () =>
      controller.abort(
        options.signal?.reason instanceof HookError
          ? options.signal.reason
          : new HookError("HOOK_ABORTED", "Hook event was aborted.", {
              cause: options.signal?.reason,
              retryable: true,
            }),
      );
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (options.signal?.aborted === true) {
      abortFromParent();
    }

    const remainingMs = Math.max(0, options.deadline - now());
    const onTimeout = () => {
      timedOut = true;
      controller.abort(
        new HookTimeoutError("HOOK_TIMEOUT", "Hook event deadline exceeded.", {
          retryable: true,
        }),
      );
    };
    if (remainingMs === 0) {
      onTimeout();
    }
    const timeout = remainingMs > 0 ? setTimeout(onTimeout, remainingMs) : undefined;

    const execute = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= items.length) {
          return;
        }

        const item = items[index];
        if (item === undefined) {
          return;
        }

        if (controller.signal.aborted) {
          results[index] = rejected(index, abortReason(controller.signal, timedOut));
          continue;
        }

        try {
          const value = await raceAbort(worker(item, index, controller.signal), controller.signal);
          results[index] = {
            index,
            status: "fulfilled",
            value,
          };
        } catch (error) {
          results[index] = rejected(index, error);
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, execute));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", abortFromParent);
    }

    const fallback = abortReason(controller.signal, timedOut);
    return Object.freeze(
      Array.from(results, (result, index) => result ?? rejected(index, fallback)),
    ) as readonly HookScheduledResult<TResult>[];
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal, timedOut: boolean): unknown {
  if (timedOut) {
    return signal.reason instanceof HookTimeoutError
      ? signal.reason
      : new HookTimeoutError("HOOK_TIMEOUT", "Hook event deadline exceeded.", {
          retryable: true,
        });
  }

  return signal.reason instanceof HookError
    ? signal.reason
    : new HookError("HOOK_ABORTED", "Hook event was aborted.", {
        cause: signal.reason,
        retryable: true,
      });
}

function rejected<TResult>(index: number, reason: unknown): HookScheduledResult<TResult> {
  return {
    index,
    reason,
    status: "rejected",
  };
}
