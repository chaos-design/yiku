import { describe, expect, it, vi } from "vitest";
import { resolveCanvasView, storeCanvasView } from "../../src/state/canvas-view.js";

describe("canvas view preference", () => {
  it("defaults to topology and restores a stored view", () => {
    expect(resolveCanvasView("", undefined)).toBe("topology");
    expect(resolveCanvasView("", storage("trajectory"))).toBe("trajectory");
    expect(resolveCanvasView("", storage("invalid"))).toBe("topology");
  });

  it("gives an explicit deep link priority over storage", () => {
    expect(resolveCanvasView("?view=topology", storage("trajectory"))).toBe("topology");
    expect(resolveCanvasView("?view=trajectory", storage("topology"))).toBe("trajectory");
  });

  it("stores valid selections and tolerates unavailable storage", () => {
    const setItem = vi.fn();
    storeCanvasView("trajectory", { setItem });
    expect(setItem).toHaveBeenCalledWith("yiku:agent-observatory:canvas-view", "trajectory");

    expect(() =>
      storeCanvasView("topology", {
        setItem: () => {
          throw new Error("unavailable");
        },
      }),
    ).not.toThrow();
  });
});

function storage(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem: () => value,
  };
}
