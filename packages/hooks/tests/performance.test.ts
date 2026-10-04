import { describe, expect, it } from "vitest";
import { HookConfigCompiler } from "../src/config/compiler.js";
import { type HookDispatchState, HookEngine } from "../src/engine.js";
import type { StopHookEvent } from "../src/types.js";

describe("Hook performance", () => {
  it("keeps no-match dispatch P95 below one millisecond", async () => {
    const engine = new HookEngine({
      snapshot: new HookConfigCompiler().compile([]).snapshot,
    });
    const event: StopHookEvent = {
      cwd: "/workspace",
      hook_event_name: "Stop",
      permission_mode: "default",
      session_id: "performance",
      stop_hook_active: false,
      transcript_path: "/tmp/performance.jsonl",
    };
    const state: HookDispatchState = {
      depth: 0,
      enqueueBackground() {},
      environment: {},
      hasRunOnce: () => false,
      markOnce() {},
    };

    for (let index = 0; index < 250; index += 1) {
      await engine.dispatch(event, state);
    }

    const durations: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const startedAt = process.hrtime.bigint();
      await engine.dispatch(event, state);
      durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThan(1);
  });
});
