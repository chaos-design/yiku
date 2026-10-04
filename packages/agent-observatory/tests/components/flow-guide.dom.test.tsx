// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowGuide } from "../../src/components/flow-guide.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("FlowGuide DOM", () => {
  it("opens, searches, clears, and closes through keyboard and backdrop controls", () => {
    act(() => root.render(<FlowGuide />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    click(container.querySelector('button[aria-label="Open flow guide"]'));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Runtime Domains");
    expect(container.querySelector('input[type="search"]')).toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    click(findButton("原子目录"));
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    setInputValue(search, "skill.resolve");
    expect(container.querySelectorAll("[data-atom-key]")).toHaveLength(1);
    setInputValue(search, "missing capability");
    expect(container.textContent).toContain("没有匹配");
    click(findButton("清除搜索"));
    expect(container.querySelectorAll("[data-atom-key]").length).toBeGreaterThan(1);
    expect(container.textContent).not.toContain("Runtime Domains");

    click(findButton("观测"));
    expect(container.textContent).toContain("Replay & Observability");
    expect(container.querySelectorAll("[data-atom-key]")).toHaveLength(0);

    pointerDown(container.querySelector(".flow-guide-drawer"));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    pointerDown(container);
    const closingDrawer = container.querySelector<HTMLElement>(".flow-guide-drawer");
    expect(closingDrawer?.getAttribute("aria-hidden")).toBe("true");
    expect(closingDrawer?.classList.contains("is-open")).toBe(false);
    finishGuideTransition(closingDrawer);
    expect(container.querySelector(".flow-guide-drawer")).toBeNull();
    click(container.querySelector('button[aria-label="Open flow guide"]'));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    finishGuideTransition(container.querySelector(".flow-guide-drawer"));
    expect(container.querySelector(".flow-guide-drawer")).toBeNull();
  });

  it("closes immediately when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    act(() => root.render(<FlowGuide />));

    click(container.querySelector('button[aria-label="Open flow guide"]'));
    pointerDown(container);

    expect(container.querySelector(".flow-guide-drawer")).toBeNull();
  });

  it("cancels pending animation frames and close timers", () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 17),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    act(() => root.render(<FlowGuide key="pending-frame" />));

    click(container.querySelector('button[aria-label="Open flow guide"]'));
    act(() => root.render(<div />));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);

    act(() => root.render(<FlowGuide key="closing-frame" />));
    click(container.querySelector('button[aria-label="Open flow guide"]'));
    pointerDown(container);
    act(() => root.render(<div />));
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);

    vi.stubGlobal("requestAnimationFrame", undefined);
    act(() => root.render(<FlowGuide key="reopened-timer" />));
    click(container.querySelector('button[aria-label="Open flow guide"]'));
    pointerDown(container);
    click(container.querySelector('button[aria-label="Open flow guide"]'));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected a clickable element.");
  }
  act(() => element.click());
}

function pointerDown(element: Element | null): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected a pointer target.");
  }
  act(() => element.dispatchEvent(new Event("pointerdown", { bubbles: true })));
}

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) {
    throw new Error(`Expected button: ${text}`);
  }
  return button;
}

function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (input === null) {
    throw new Error("Expected search input.");
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function finishGuideTransition(element: Element | null): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected flow guide drawer.");
  }
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: "transform" });
  act(() => element.dispatchEvent(event));
}
