// @vitest-environment jsdom

import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TrajectoryView } from "../../src/components/trajectory-view.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("TrajectoryView DOM", () => {
  it("shows start time and duration when an overview block is hovered", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        public disconnect(): void {}

        public observe(): void {}

        public unobserve(): void {}
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <TrajectoryView
          events={[
            event(1, "tool.call", "tool-1", "start"),
            event(3, "tool.call", "tool-1", "end"),
          ]}
          onSelectSequence={vi.fn()}
          replaySequence={3}
        />,
      );
    });

    const marker = container.querySelector<HTMLElement>(".trajectory-overview-track .kind-tools");
    await act(async () => {
      marker?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    const tooltip = document.body.querySelector(".trajectory-overview-tooltip");
    expect(tooltip?.textContent).toContain("tool.call");
    expect(tooltip?.textContent).toContain("Started");
    expect(tooltip?.textContent).toContain("Duration");
    expect(tooltip?.textContent).toContain("2.00 s");

    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("collapses descendants and selects their latest Atomic sequence", () => {
    const onSelectSequence = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <TrajectoryView
          events={[
            event(1, "run", "run-1", "start"),
            event(2, "tool.call", "tool-1", "start", "run-1"),
            event(3, "tool.call", "tool-1", "end", "run-1"),
          ]}
          onSelectSequence={onSelectSequence}
          replaySequence={3}
        />,
      );
    });

    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    click(container, "Collapse run");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    click(container, "Expand run");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);

    const rows = container.querySelectorAll<HTMLButtonElement>(".trajectory-select");
    act(() => rows[1]?.click());
    expect(onSelectSequence).toHaveBeenCalledWith(3);

    act(() => root.unmount());
  });

  it("highlights a row without changing the list or scrolling, then honors explicit locate", () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    const onLocateCurrent = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    HTMLElement.prototype.scrollTo = scrollTo;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const selectedMarker = this.tagName === "I" && this.classList.contains("is-selected");
      const left = selectedMarker ? 150 : 0;
      const right = selectedMarker ? 164 : 100;
      const width = right - left;
      return {
        bottom: 12,
        height: 12,
        left,
        right,
        toJSON: () => ({}),
        top: 0,
        width,
        x: left,
        y: 0,
      };
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const events = [
      event(1, "run", "run-1", "start"),
      event(2, "tool.call", "tool-1", "end", "run-1"),
      event(3, "tool.call", "tool-2", "end", "run-1"),
    ];

    act(() => root.render(<HighlightHarness events={events} onLocateCurrent={onLocateCurrent} />));
    scrollIntoView.mockClear();
    scrollTo.mockClear();
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3);

    act(() => container.querySelectorAll<HTMLButtonElement>(".trajectory-select")[1]?.click());
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    expect(
      container
        .querySelectorAll<HTMLButtonElement>(".trajectory-select")[1]
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector('[aria-label="Back to run overview"]')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({
      behavior: "smooth",
      left: 107,
    });
    expect(
      container.querySelector(".trajectory-overview-track i.is-selected.is-locating"),
    ).not.toBeNull();

    click(container, "Locate current trajectory step");
    expect(onLocateCurrent).toHaveBeenCalledOnce();

    act(() =>
      root.render(
        <HighlightHarness events={events} locateRequest={1} onLocateCurrent={onLocateCurrent} />,
      ),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });

    act(() => root.unmount());
  });
});

function HighlightHarness({
  events,
  locateRequest = 0,
  onLocateCurrent,
}: {
  readonly events: readonly AtomicFlowEvent[];
  readonly locateRequest?: number | undefined;
  readonly onLocateCurrent?: (() => void) | undefined;
}) {
  const latestSequence = events.at(-1)?.sequence ?? 0;
  const [selectedSequence, setSelectedSequence] = useState(latestSequence);
  const [revealRequest, setRevealRequest] = useState(0);
  return (
    <TrajectoryView
      events={events}
      followActive
      locateRequest={locateRequest}
      onLocateCurrent={onLocateCurrent}
      onSelectSequence={(sequence) => {
        setSelectedSequence(sequence);
        setRevealRequest((current) => current + 1);
      }}
      overviewRevealRequest={locateRequest + revealRequest}
      replaySequence={latestSequence}
      selectedSequence={selectedSequence}
    />
  );
}

function click(container: HTMLElement, label: string): void {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  act(() => button?.click());
}

function event(
  sequence: number,
  atomKey: string,
  instanceId: string,
  phase: AtomicFlowEvent["phase"],
  parentId?: string,
): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind: atomKey === "tool.call" ? "tool" : "input",
      label: atomKey,
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: instanceId,
      ...(parentId !== undefined ? { parentId } : {}),
    },
    occurredAt: new Date(sequence * 1_000).toISOString(),
    phase,
    runId: "run",
    sequence,
  };
}
