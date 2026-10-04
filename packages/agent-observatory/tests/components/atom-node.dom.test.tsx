// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomNode } from "../../src/components/atom-node.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { AtomLayout } from "../../src/data/atom-layout.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      public disconnect(): void {}

      public observe(): void {}

      public unobserve(): void {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AtomNode DOM", () => {
  it("shows the responsibility and protocol metadata on hover", async () => {
    renderAtom();
    const trigger = container.querySelector<HTMLButtonElement>(".atom-node");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    const tooltip = document.body.querySelector(".atom-node-tooltip");
    expect(tooltip?.textContent).toContain("Task Snapshot");
    expect(tooltip?.textContent).toContain("持久任务");
    expect(tooltip?.textContent).toContain("task.snapshot");
    expect(tooltip?.textContent).toContain("store");
    expect(tooltip?.textContent).toContain("session");
  });

  it("selects only an observed atom instance", () => {
    const onSelect = vi.fn();
    renderAtom(onSelect, 7);

    act(() => container.querySelector<HTMLButtonElement>(".atom-node")?.click());
    expect(onSelect).toHaveBeenCalledWith(7);

    renderAtom(onSelect);
    act(() => container.querySelector<HTMLButtonElement>(".atom-node")?.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

function renderAtom(onSelect = vi.fn(), lastSequence?: number): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <AtomNode
          atom={atom()}
          executionActive={false}
          observed={lastSequence !== undefined}
          onSelect={onSelect}
          selected={false}
          view={
            lastSequence === undefined
              ? undefined
              : {
                  count: 1,
                  latest: { lastSequence, status: "completed" } as never,
                }
          }
        />
      </TooltipProvider>,
    ),
  );
}

function atom(): AtomLayout {
  return {
    domain: "session",
    focus: "user",
    key: "task.snapshot",
    kind: "store",
    label: "Task Snapshot",
    level: "runtime",
    width: 118,
    x: 0,
    y: 0,
  };
}
