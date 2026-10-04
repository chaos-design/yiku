import { describe, expect, it, vi } from "vitest";
import { OperationHookAdapter } from "../../src/hooks/operation-adapter.js";

describe("OperationHookAdapter", () => {
  it("preserves operation order with bounded execution", async () => {
    const order: string[] = [];
    const adapter = new OperationHookAdapter([
      {
        name: "observer",
        onOperation: async (event) => {
          await Promise.resolve();
          order.push(event.operationId);
        },
      },
    ]);

    adapter.enqueue(operation("one"));
    adapter.enqueue(operation("two"));
    adapter.enqueue(operation("three"));
    await adapter.flush();

    expect(order).toEqual(["one", "two", "three"]);
  });

  it("reports non-fatal failures and propagates fatal policy after siblings run", async () => {
    const onDiagnostic = vi.fn();
    const sibling = vi.fn();
    const adapter = new OperationHookAdapter(
      [
        {
          fatal: true,
          name: "fatal",
          onOperation: () => {
            throw new Error("fatal failure");
          },
        },
        {
          name: "sibling",
          onOperation: sibling,
        },
      ],
      { onDiagnostic },
    );

    await expect(adapter.notify(operation("fatal"))).rejects.toThrow("fatal failure");
    expect(sibling).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "OPERATION_HOOK_FAILED",
        fatal: true,
      }),
    );
  });

  it("bounds pending work and exposes overflow diagnostics", async () => {
    let release: (() => void) | undefined;
    const onDiagnostic = vi.fn();
    const adapter = new OperationHookAdapter(
      [
        {
          name: "slow",
          onOperation: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
      { maxPending: 1, onDiagnostic },
    );

    adapter.enqueue(operation("one"));
    adapter.enqueue(operation("two"));
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OPERATION_HOOK_QUEUE_FULL" }),
    );
    release?.();
    await adapter.flush();
  });

  it("validates resource limits", () => {
    expect(() => new OperationHookAdapter([], { maxConcurrency: 0 })).toThrow("positive integer");
    expect(() => new OperationHookAdapter([], { maxPending: 0 })).toThrow("positive integer");
  });
});

function operation(operationId: string) {
  return {
    kind: "run",
    name: "run",
    operationId,
    phase: "start",
    startedAt: "2026-08-01T00:00:00.000Z",
    status: "running",
  } as const;
}
