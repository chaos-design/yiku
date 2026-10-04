import { EvaluationError } from "./errors.js";

export interface SemaphoreLease {
  readonly queuedMs: number;
  release(): void;
}

interface Waiter {
  readonly enqueuedAt: number;
  readonly reject: (error: EvaluationError) => void;
  readonly resolve: (lease: SemaphoreLease) => void;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort?: (() => void) | undefined;
}

export class AsyncSemaphore {
  private active = 0;
  private readonly maximum: number;
  private readonly now: () => number;
  private readonly waiters: Waiter[] = [];

  public constructor(maximum: number, now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        "Evaluation concurrency limit must be a positive integer.",
      );
    }
    this.maximum = maximum;
    this.now = now;
  }

  public acquire(signal?: AbortSignal): Promise<SemaphoreLease> {
    if (signal?.aborted) {
      return Promise.reject(aborted(signal));
    }
    const enqueuedAt = this.now();
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.lease(enqueuedAt));
    }

    return new Promise<SemaphoreLease>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt,
        reject,
        resolve,
        ...(signal !== undefined ? { signal } : {}),
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          reject(aborted(signal));
        }
      };
      Object.assign(waiter, { onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  public activeCount(): number {
    return this.active;
  }

  public pendingCount(): number {
    return this.waiters.length;
  }

  private lease(enqueuedAt: number): SemaphoreLease {
    let released = false;
    return {
      queuedMs: Math.max(0, this.now() - enqueuedAt),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.maximum) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        return;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      if (waiter.signal?.aborted) {
        waiter.reject(aborted(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.lease(waiter.enqueuedAt));
    }
  }
}

function aborted(signal: AbortSignal | undefined): EvaluationError {
  return new EvaluationError("EVAL_ABORTED", "Evaluation was aborted.", {
    cause: signal?.reason,
  });
}
