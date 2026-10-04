import { describe, expect, it, vi } from "vitest";
import { dispatchHooks } from "../../src/hooks/dispatcher.js";

describe("dispatchHooks", () => {
  it("continues after non-fatal hook failures", async () => {
    const secondHook = vi.fn();

    await expect(
      dispatchHooks(
        [
          {
            name: "broken",
            onOperation: () => {
              throw new Error("hook failed");
            },
          },
          {
            name: "second",
            onOperation: secondHook,
          },
        ],
        operation(),
      ),
    ).resolves.toBeUndefined();
    expect(secondHook).toHaveBeenCalledOnce();
  });

  it("throws fatal hook failures", async () => {
    await expect(
      dispatchHooks(
        [
          {
            fatal: true,
            name: "fatal",
            onOperation: () => {
              throw new Error("fatal hook failed");
            },
          },
        ],
        operation(),
      ),
    ).rejects.toThrow("fatal hook failed");
  });
});

function operation() {
  return {
    kind: "run",
    name: "run",
    operationId: "operation-1",
    phase: "start",
    startedAt: "2026-07-31T00:00:00.000Z",
    status: "running",
  } as const;
}
