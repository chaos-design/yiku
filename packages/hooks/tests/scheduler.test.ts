import { describe, expect, it } from "vitest";
import { HookError, HookTimeoutError } from "../src/errors.js";
import { HookScheduler } from "../src/scheduler.js";

describe("HookScheduler", () => {
  it("bounds concurrency and returns results in input order", async () => {
    const scheduler = new HookScheduler();
    let active = 0;
    let peak = 0;

    const results = await scheduler.run(
      [30, 5, 15, 1],
      async (delay, index) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(delay);
        active -= 1;
        return `result-${index}`;
      },
      {
        deadline: Date.now() + 1_000,
        maxConcurrency: 2,
      },
    );

    expect(peak).toBe(2);
    expect(results).toEqual([
      { index: 0, status: "fulfilled", value: "result-0" },
      { index: 1, status: "fulfilled", value: "result-1" },
      { index: 2, status: "fulfilled", value: "result-2" },
      { index: 3, status: "fulfilled", value: "result-3" },
    ]);
  });

  it("keeps worker failures isolated", async () => {
    const results = await new HookScheduler().run(
      ["ok", "broken", "still-ok"],
      async (value) => {
        if (value === "broken") {
          throw new Error("failed");
        }
        return value;
      },
      {
        deadline: Date.now() + 1_000,
        maxConcurrency: 3,
      },
    );

    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "still-ok" });
  });

  it("rejects unstarted work after an expired deadline", async () => {
    const results = await new HookScheduler().run([1, 2], async (value) => value, {
      deadline: 0,
      maxConcurrency: 1,
      now: () => 1,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((results[0] as { readonly reason: unknown }).reason).toBeInstanceOf(HookTimeoutError);
  });

  it("propagates parent cancellation as a typed abort", async () => {
    const controller = new AbortController();
    controller.abort("canceled");
    const results = await new HookScheduler().run([1], async (value) => value, {
      deadline: Date.now() + 1_000,
      maxConcurrency: 1,
      signal: controller.signal,
    });

    expect((results[0] as { readonly reason: unknown }).reason).toBeInstanceOf(HookError);
    expect((results[0] as { readonly reason: HookError }).reason.code).toBe("HOOK_ABORTED");
  });

  it("preserves a typed parent abort reason", async () => {
    const controller = new AbortController();
    const reason = new HookError("HOOK_ABORTED", "Typed cancellation.");
    controller.abort(reason);
    const results = await new HookScheduler().run([1], async (value) => value, {
      deadline: Date.now() + 1_000,
      maxConcurrency: 1,
      signal: controller.signal,
    });

    expect((results[0] as { readonly reason: unknown }).reason).toBe(reason);
  });

  it("returns typed fallback failures for sparse input", async () => {
    const items = new Array<number>(2);
    const results = await new HookScheduler().run(items, async (value) => value, {
      deadline: Date.now() + 1_000,
      maxConcurrency: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((results[0] as { readonly reason: unknown }).reason).toBeInstanceOf(HookError);
  });

  it("returns immediately for empty input", async () => {
    await expect(
      new HookScheduler().run([], async (value) => value, {
        deadline: Date.now() + 1_000,
        maxConcurrency: 1,
      }),
    ).resolves.toEqual([]);
  });
});

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
