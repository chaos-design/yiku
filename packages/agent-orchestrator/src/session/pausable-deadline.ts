export interface PausableDeadlineOptions {
  readonly now?: (() => number) | undefined;
}

type DeadlineStatus = "closed" | "paused" | "running";

export class PausableDeadline {
  private readonly now: () => number;
  private remaining: number;
  private startedAt: number;
  private status: DeadlineStatus = "running";
  private timeout?: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    durationMs: number,
    private readonly onTimeout: () => void,
    options: PausableDeadlineOptions = {},
  ) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new Error("Pausable deadline duration must be a positive integer.");
    }
    this.now = options.now ?? Date.now;
    this.remaining = durationMs;
    this.startedAt = this.now();
    this.schedule();
  }

  public pause(): void {
    if (this.status !== "running") {
      return;
    }
    this.consumeElapsed();
    this.clearTimer();
    this.status = "paused";
    if (this.remaining === 0) {
      this.trigger();
    }
  }

  public resume(): void {
    if (this.status !== "paused") {
      return;
    }
    if (this.remaining === 0) {
      this.trigger();
      return;
    }
    this.status = "running";
    this.startedAt = this.now();
    this.schedule();
  }

  public close(): void {
    if (this.status === "closed") {
      return;
    }
    if (this.status === "running") {
      this.consumeElapsed();
    }
    this.clearTimer();
    this.status = "closed";
  }

  public remainingMs(): number {
    if (this.status !== "running") {
      return this.remaining;
    }
    return Math.max(0, this.remaining - Math.max(0, this.now() - this.startedAt));
  }

  private clearTimer(): void {
    if (this.timeout === undefined) {
      return;
    }
    clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  private consumeElapsed(): void {
    const elapsed = Math.max(0, this.now() - this.startedAt);
    this.remaining = Math.max(0, this.remaining - elapsed);
  }

  private schedule(): void {
    this.timeout = setTimeout(() => this.trigger(), this.remaining);
  }

  private trigger(): void {
    if (this.status === "closed") {
      return;
    }
    this.clearTimer();
    this.remaining = 0;
    this.status = "closed";
    this.onTimeout();
  }
}
