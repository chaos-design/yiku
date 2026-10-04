import { describe, expect, it } from "vitest";
import { WorkspaceWriteLock } from "../../src/tasks/write-lock.js";

describe("WorkspaceWriteLock", () => {
  it("runs writers one at a time in FIFO order", async () => {
    const lock = new WorkspaceWriteLock();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.runExclusive(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
      return "first";
    });
    const second = lock.runExclusive(async () => {
      order.push("second:start");
      order.push("second:end");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("releases the lock after a writer fails", async () => {
    const lock = new WorkspaceWriteLock();

    await expect(
      lock.runExclusive(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(lock.runExclusive(async () => "recovered")).resolves.toBe("recovered");
  });
});
