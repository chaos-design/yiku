// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayControls } from "../../src/components/replay-controls.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ReplayControls DOM", () => {
  it("drives replay actions, speed cycling and timer progression", () => {
    const onLive = vi.fn();
    const onPlayingChange = vi.fn();
    const onSeek = vi.fn();
    const container = mount(
      <ReplayControls
        eventCount={3}
        eventPosition={1}
        live={false}
        onLive={onLive}
        onPlayingChange={onPlayingChange}
        onSeek={onSeek}
        playing={true}
      />,
    );

    click(container, "Replay from first event");
    click(container, "Previous event");
    click(container, "Pause replay");
    click(container, "Next event");
    const speed = container.querySelector<HTMLButtonElement>('button[aria-label^="Replay speed"]');
    for (let index = 0; index < 3; index += 1) {
      act(() => speed?.click());
    }
    expect(speed?.textContent).toBe("0.5×");
    click(container, "Follow live events");
    act(() => vi.runOnlyPendingTimers());

    expect(onSeek).toHaveBeenCalledWith(1);
    expect(onSeek).toHaveBeenCalledWith(2);
    expect(onPlayingChange).toHaveBeenCalledWith(false);
    expect(onLive).toHaveBeenCalled();
  });

  it("stops playback at the end and disables empty controls", () => {
    const onPlayingChange = vi.fn();
    const container = mount(
      <ReplayControls
        eventCount={0}
        eventPosition={0}
        live={true}
        onLive={vi.fn()}
        onPlayingChange={onPlayingChange}
        onSeek={vi.fn()}
        playing={false}
      />,
    );
    expect(container.querySelectorAll("button:disabled")).toHaveLength(5);

    const ended = mount(
      <ReplayControls
        eventCount={2}
        eventPosition={2}
        live={false}
        onLive={vi.fn()}
        onPlayingChange={onPlayingChange}
        onSeek={vi.fn()}
        playing={true}
      />,
    );
    expect(ended.querySelector('[aria-label="Pause replay"]')).not.toBeNull();
    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });
});

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

function click(container: HTMLElement, label: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
  });
}
