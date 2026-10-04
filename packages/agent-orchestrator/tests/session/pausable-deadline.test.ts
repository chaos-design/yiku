import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PausableDeadline } from "../../src/session/pausable-deadline.js";

describe("PausableDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts only running time toward the deadline", async () => {
    const onTimeout = vi.fn();
    const deadline = new PausableDeadline(100, onTimeout);

    await vi.advanceTimersByTimeAsync(40);
    deadline.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(deadline.remainingMs()).toBe(60);

    deadline.resume();
    await vi.advanceTimersByTimeAsync(59);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(deadline.remainingMs()).toBe(0);
  });

  it("makes repeated pause and resume calls idempotent", async () => {
    const onTimeout = vi.fn();
    const deadline = new PausableDeadline(100, onTimeout);

    await vi.advanceTimersByTimeAsync(25);
    deadline.pause();
    deadline.pause();
    await vi.advanceTimersByTimeAsync(100);
    deadline.resume();
    deadline.resume();
    await vi.advanceTimersByTimeAsync(75);

    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("closes without firing and ignores later state changes", async () => {
    const onTimeout = vi.fn();
    const deadline = new PausableDeadline(100, onTimeout);

    await vi.advanceTimersByTimeAsync(20);
    deadline.close();
    deadline.pause();
    deadline.resume();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(deadline.remainingMs()).toBe(80);
    deadline.close();
  });

  it("validates the duration", () => {
    expect(() => new PausableDeadline(0, vi.fn())).toThrow(
      "Pausable deadline duration must be a positive integer.",
    );
    expect(() => new PausableDeadline(1.5, vi.fn())).toThrow(
      "Pausable deadline duration must be a positive integer.",
    );
  });

  it("fires immediately when pausing after the measured deadline", () => {
    const onTimeout = vi.fn();
    let now = 0;
    const deadline = new PausableDeadline(10, onTimeout, { now: () => now });

    now = 10;
    deadline.pause();

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(deadline.remainingMs()).toBe(0);
  });

  it("reports running time and closes while paused", () => {
    let now = 10;
    const deadline = new PausableDeadline(100, vi.fn(), { now: () => now });

    now = 40;
    expect(deadline.remainingMs()).toBe(70);
    deadline.pause();
    deadline.close();
    expect(deadline.remainingMs()).toBe(70);
  });
});
