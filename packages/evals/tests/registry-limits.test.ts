import { describe, expect, it } from "vitest";
import { AsyncSemaphore, EvaluationError, EvaluatorRegistry } from "../src/index.js";
import type { EvalCheckEvaluator } from "../src/types.js";

describe("EvaluatorRegistry", () => {
  it("lists stable descriptors and rejects invalid or duplicate registrations", () => {
    const registry = new EvaluatorRegistry([evaluator("b"), evaluator("a")]);
    expect(registry.list().map((item) => item.key)).toEqual(["a", "b"]);
    expect(registry.get("a")?.descriptor.label).toBe("a");
    expect(registry.get("missing")).toBeUndefined();
    expect(() => registry.register(evaluator("a"))).toThrow("Duplicate");
    for (const descriptor of [
      { ...evaluator("valid").descriptor, key: "" },
      { ...evaluator("valid").descriptor, capability: "" },
      { ...evaluator("valid").descriptor, version: "" },
      { ...evaluator("valid").descriptor, label: "" },
      { ...evaluator("valid").descriptor, deterministic: "yes" },
    ]) {
      expect(
        () =>
          new EvaluatorRegistry([
            {
              ...evaluator("valid"),
              descriptor: descriptor as EvalCheckEvaluator["descriptor"],
            },
          ]),
      ).toThrow(EvaluationError);
    }
  });
});

describe("AsyncSemaphore", () => {
  it("queues FIFO leases, tracks counts, and tolerates duplicate release", async () => {
    let now = 0;
    const semaphore = new AsyncSemaphore(1, () => now++);
    const first = await semaphore.acquire();
    const secondPromise = semaphore.acquire();
    expect(semaphore.activeCount()).toBe(1);
    expect(semaphore.pendingCount()).toBe(1);
    first.release();
    first.release();
    const second = await secondPromise;
    expect(second.queuedMs).toBeGreaterThanOrEqual(0);
    second.release();
    expect(semaphore.activeCount()).toBe(0);
  });

  it("rejects invalid limits and removes aborted waiters", async () => {
    expect(() => new AsyncSemaphore(0)).toThrow("positive integer");
    const semaphore = new AsyncSemaphore(1);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    expect(semaphore.pendingCount()).toBe(0);
    first.release();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(semaphore.acquire(alreadyAborted.signal)).rejects.toMatchObject({
      code: "EVAL_ABORTED",
    });
  });

  it("skips waiters whose signal aborts immediately before queue draining", async () => {
    const semaphore = new AsyncSemaphore(1);
    const first = await semaphore.acquire();
    const listeners: Array<() => void> = [];
    const mutableSignal = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      reason: new Error("late abort"),
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const waiting = semaphore.acquire(mutableSignal);
    (mutableSignal as unknown as { aborted: boolean }).aborted = true;
    first.release();

    await expect(waiting).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    for (const listener of listeners) {
      listener();
    }
    expect(semaphore.activeCount()).toBe(0);
    expect(semaphore.pendingCount()).toBe(0);
  });
});

function evaluator(key: string): EvalCheckEvaluator {
  return {
    descriptor: {
      capability: key,
      deterministic: true,
      key,
      label: key,
      version: "1.0.0",
    },
    evaluate(check) {
      return {
        dimension: check.dimension,
        durationMs: 0,
        evaluator: check.evaluator,
        evidenceRefs: [],
        id: check.id,
        label: check.id,
        passed: true,
        required: check.required,
        retryable: false,
        severity: check.severity,
        status: "passed",
        summary: "Passed.",
        version: 1,
      };
    },
  };
}
