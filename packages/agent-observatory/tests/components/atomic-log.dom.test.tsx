// @vitest-environment jsdom

import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicLog, formatEventTime } from "../../src/components/atomic-log.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];
const scrollTo = vi.fn();
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollTo.mockReset();
  scrollIntoView.mockReset();
  HTMLElement.prototype.scrollTo = scrollTo;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return {
      bottom: this.classList.contains("atomic-log-list") ? 200 : 100,
      height: 100,
      left: 0,
      right: 100,
      toJSON: () => ({}),
      top: 0,
      width: 100,
      x: 0,
      y: 0,
    };
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AtomicLog DOM", () => {
  it("filters, selects, scrolls and follows playback", async () => {
    const container = mount(<Harness />);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    setInput(input, "missing");
    await flush();
    expect(container.textContent).toContain("No matching events");

    setInput(input, "tokens");
    await flush();
    expect(container.textContent).toContain("tool.call");
    const row = container.querySelector<HTMLButtonElement>(".atomic-log-row");
    act(() => row?.click());
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    act(() => row?.click());

    act(() => container.querySelector(".atomic-log-list")?.dispatchEvent(new Event("scroll")));
    expect(formatEventTime("not-a-date")).toEqual({ date: "not-a-date", time: "" });
  });

  it("shows scroll controls only for available directions", () => {
    const container = mount(
      <AtomicLog events={[event(1), event(2)]} onSelect={vi.fn()} playing={false} />,
    );

    setLogGeometry(container, { clientHeight: 100, scrollHeight: 300, scrollTop: 0 });
    expect(scrollButton(container, "top")).toBeNull();
    expect(scrollButton(container, "bottom")).not.toBeNull();
    click(container, "Scroll atomic log to bottom");
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 300 });

    setLogGeometry(container, { clientHeight: 100, scrollHeight: 300, scrollTop: 100 });
    expect(scrollButton(container, "top")).not.toBeNull();
    expect(scrollButton(container, "bottom")).not.toBeNull();
    click(container, "Scroll atomic log to top");
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 0 });

    setLogGeometry(container, { clientHeight: 100, scrollHeight: 300, scrollTop: 200 });
    expect(scrollButton(container, "top")).not.toBeNull();
    expect(scrollButton(container, "bottom")).toBeNull();

    setLogGeometry(container, { clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
    expect(scrollButton(container, "top")).toBeNull();
    expect(scrollButton(container, "bottom")).toBeNull();
  });

  it("scrolls the selected row while replay is active", async () => {
    const onLocateCurrent = vi.fn();
    const container = mount(
      <AtomicLog
        events={[event(1), event(2)]}
        onLocateCurrent={onLocateCurrent}
        onSelect={vi.fn()}
        playing={true}
        selectedSequence={2}
      />,
    );
    await flush();
    expect(container.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();

    setInput(container.querySelector('input[type="search"]'), "missing");
    await flush();
    expect(container.textContent).toContain("No matching events");
    click(container, "Locate current running node");
    await flush();
    expect(container.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
    expect(onLocateCurrent).toHaveBeenCalledOnce();
  });

  it("reveals a selected log row from an external locate request", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const events = [event(1), event(2)];
    act(() => {
      root.render(
        <AtomicLog
          events={events}
          locateRequest={0}
          onSelect={vi.fn()}
          playing={false}
          selectedSequence={2}
        />,
      );
    });
    setInput(container.querySelector('input[type="search"]'), "missing");
    await flush();
    expect(container.textContent).toContain("No matching events");
    scrollIntoView.mockClear();

    act(() => {
      root.render(
        <AtomicLog
          events={events}
          locateRequest={1}
          onSelect={vi.fn()}
          playing={false}
          selectedSequence={2}
        />,
      );
    });
    await flush();

    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
  });
});

function Harness() {
  const [selected, setSelected] = useState<number>();
  return (
    <AtomicLog
      events={[event(1), event(2)]}
      onSelect={setSelected}
      playing={false}
      selectedSequence={selected}
    />
  );
}

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

function setInput(input: HTMLInputElement | null, value: string): void {
  act(() => {
    if (input !== null) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(container: HTMLElement, label: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
  });
}

function scrollButton(container: HTMLElement, side: "bottom" | "top"): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`.log-scroll-button.is-${side}`);
}

function setLogGeometry(
  container: HTMLElement,
  geometry: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
): void {
  const list = container.querySelector<HTMLElement>(".atomic-log-list");
  if (list === null) {
    throw new Error("Expected atomic log list.");
  }
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    scrollTop: { configurable: true, value: geometry.scrollTop, writable: true },
  });
  act(() => list.dispatchEvent(new Event("scroll")));
}

function event(sequence: number): AtomicFlowEvent {
  return {
    atom: {
      key: sequence === 1 ? "input.prompt" : "tool.call",
      kind: sequence === 1 ? "input" : "tool",
      label: sequence === 1 ? "Prompt" : "Tool Call",
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: `instance-${sequence}`,
      ...(sequence === 2 ? { iteration: 2 } : {}),
    },
    occurredAt: "2026-08-07T00:00:01.000Z",
    ...(sequence === 2
      ? {
          payload: {
            code: "TOOL",
            counts: { attempts: 1 },
            summary: "Tokens available",
            title: "Run tool",
            values: { tokens: 42 },
          },
        }
      : {}),
    phase: sequence === 1 ? "start" : "end",
    runId: "run-1",
    sequence,
  };
}
