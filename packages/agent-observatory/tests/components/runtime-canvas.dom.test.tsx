// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasContainScale, RuntimeCanvas } from "../../src/components/runtime-canvas.js";
import { ATOMS, EDGES } from "../../src/data/atom-layout.js";
import type { FlowLayout } from "../../src/data/flow-layout.js";

const layoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/flow-layout.js", () => ({
  FlowLayoutEngine: class {
    public layout(...args: unknown[]) {
      return layoutMock(...args);
    }
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];
const disconnect = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  layoutMock.mockReset();
  disconnect.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 300,
    height: 300,
    left: 0,
    right: 500,
    toJSON: () => ({}),
    top: 0,
    width: 500,
    x: 0,
    y: 0,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      public constructor(private readonly callback: ResizeObserverCallback) {}
      public disconnect = disconnect;
      public observe(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
      public unobserve(): void {}
    },
  );
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RuntimeCanvas DOM", () => {
  it("renders an ambient initial state without visible implementation copy", async () => {
    const pending = deferred<FlowLayout>();
    layoutMock.mockReturnValue(pending.promise);
    const view = mount();

    expect(view.container.querySelector(".runtime-canvas-preparing")).not.toBeNull();
    expect(
      view.container.querySelector(".runtime-canvas-viewport")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(view.container.textContent).not.toContain("Computing flow layout");

    pending.resolve(layout());
    await flush();

    expect(view.container.querySelectorAll(".flow-skeleton-node")).toHaveLength(5);
    expect(view.container.querySelectorAll(".flow-skeleton-edge")).toHaveLength(3);
    expect(view.container.querySelector(".runtime-canvas-preparing")?.className).toContain(
      "is-exiting",
    );
    expect(view.container.querySelector(".runtime-canvas-fit")?.className).toContain("is-entering");
    await finishInitialTransition();

    expect(view.container.querySelector(".runtime-canvas-preparing")).toBeNull();
    expect(view.container.querySelector(".runtime-canvas-fit")?.className).not.toContain(
      "is-entering",
    );
    expect(
      view.container.querySelector(".runtime-canvas-viewport")?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("waits for the initial Run snapshot before computing topology", async () => {
    layoutMock.mockResolvedValue(layout());
    const view = mount(false);
    await flush();

    expect(layoutMock).not.toHaveBeenCalled();
    expect(view.container.querySelector(".runtime-canvas-preparing")).not.toBeNull();

    view.render(false, true);
    await flush();

    expect(layoutMock).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".runtime-canvas-fit")).not.toBeNull();
  });

  it("measures, lays out and fills the graph viewport with ResizeObserver", async () => {
    layoutMock.mockResolvedValue(layout());
    const { container } = mount();
    await flush();

    const viewport = container.querySelector<HTMLElement>(".runtime-canvas-viewport");
    expect(viewport?.dataset.canvasScale).toBe("0.476");
    expect(viewport?.dataset.measuredWidth).toBe("500");
    expect(container.textContent).not.toContain("Computing flow layout");
    expect(layoutMock).toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event("resize")));
    expect(viewport?.dataset.layoutKey).toBe("open");
  });

  it("uses contain scaling with canvas padding and a bounded desktop zoom", () => {
    expect(canvasContainScale(1_000, 500, 500, 300)).toBeCloseTo(0.476);
    expect(canvasContainScale(1_000, 500, 2_000, 1_000)).toBe(1.15);
    expect(canvasContainScale(0, 500, 500, 300)).toBe(1);
  });

  it("focuses the requested topology atom without scrolling the page", async () => {
    const atom = ATOMS[0];
    if (atom === undefined) {
      throw new Error("Expected at least one configured atom.");
    }
    layoutMock.mockResolvedValue({ ...layout(), atoms: [atom] });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = mount();
    await flush();

    view.render(false, true, 1, atom.key);

    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("keeps the previous flow visible while recomputing a new graph", async () => {
    const refresh = deferred<FlowLayout>();
    layoutMock.mockResolvedValueOnce(layout());
    const view = mount();
    await flush();
    await finishInitialTransition();
    layoutMock.mockReturnValueOnce(refresh.promise);

    view.render(true);
    await flush();

    expect(view.container.querySelector(".runtime-canvas-fit")?.className).toContain(
      "is-reflowing",
    );
    expect(view.container.querySelector(".runtime-canvas-routing-indicator")).not.toBeNull();
    expect(view.container.querySelector(".runtime-canvas-preparing")).toBeNull();

    refresh.resolve({ ...layout(), width: 800 });
    await flush();

    expect(view.container.querySelector(".runtime-canvas-fit")?.className).not.toContain(
      "is-reflowing",
    );
    expect(view.container.querySelector(".runtime-canvas-routing-indicator")).toBeNull();
    expect(
      view.container.querySelector<HTMLElement>(".runtime-canvas-viewport")?.dataset.canvasSize,
    ).toBe("800:500");

    view.render(false);
    await flush();

    expect(layoutMock).toHaveBeenCalledTimes(2);
    expect(
      view.container.querySelector<HTMLElement>(".runtime-canvas-viewport")?.dataset.canvasSize,
    ).toBe("1000:500");
  });

  it("renders initial failures and supports browsers without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    layoutMock.mockRejectedValue("layout unavailable");
    const { container } = mount();
    await flush();

    expect(container.textContent).toContain("layout unavailable");
    expect(container.querySelector(".runtime-canvas-loading")?.className).toContain("is-error");
    expect(
      container.querySelector<HTMLElement>(".runtime-canvas-viewport")?.dataset.layoutState,
    ).toBe("error");
  });

  it("keeps the previous flow visible when a background layout fails", async () => {
    layoutMock.mockResolvedValueOnce(layout());
    const view = mount();
    await flush();
    await finishInitialTransition();
    layoutMock.mockRejectedValueOnce("refresh unavailable");

    view.render(true);
    await flush();

    expect(view.container.querySelector(".runtime-canvas-fit")).not.toBeNull();
    expect(view.container.querySelector(".runtime-canvas-fit")?.className).not.toContain(
      "is-reflowing",
    );
    expect(view.container.querySelector(".runtime-canvas-refresh-error")?.textContent).toContain(
      "refresh unavailable",
    );
    expect(
      view.container.querySelector<HTMLElement>(".runtime-canvas-viewport")?.dataset.layoutState,
    ).toBe("error");
  });
});

function mount(layoutReady = true): {
  readonly container: HTMLElement;
  readonly render: (
    deepView: boolean,
    layoutReady?: boolean,
    locateRequest?: number,
    locateAtomKey?: string,
  ) => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (
    deepView = false,
    ready = layoutReady,
    locateRequest = 0,
    locateAtomKey?: string,
  ) => {
    act(() => {
      root.render(
        <RuntimeCanvas
          atomDefinitions={[]}
          atomViews={new Map()}
          deepView={deepView}
          edges={EDGES}
          edgeViews={new Map()}
          executionActive={false}
          layoutReady={ready}
          layoutKey="open"
          locateAtomKey={locateAtomKey}
          locateRequest={locateRequest}
          onSelectSequence={vi.fn()}
          observedAtomKeys={new Set()}
        />,
      );
    });
  };
  render();
  return { container, render };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function finishInitialTransition(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

function layout(): FlowLayout {
  return {
    atoms: [],
    diagnostics: [],
    domains: [],
    edges: [],
    height: 500,
    metrics: {
      bends: 0,
      collisions: 0,
      crossings: 0,
      fallbackCount: 0,
      length: 0,
      overlap: 0,
      portDeviation: 0,
      proximity: 0,
    },
    width: 1_000,
  };
}
