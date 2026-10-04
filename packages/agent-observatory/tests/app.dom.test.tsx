// @vitest-environment jsdom

import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDetail, RunSummary } from "../src/types.js";

const api = vi.hoisted(() => ({
  announceBrowserPresence: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock("../src/api.js", () => api);
vi.mock("../src/components/runtime-canvas.js", () => ({
  RuntimeCanvas: ({
    onSelectSequence,
  }: {
    readonly onSelectSequence: (sequence: number) => void;
  }) => (
    <button onClick={() => onSelectSequence(1)} type="button">
      Runtime Canvas
    </button>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];
const eventSources: FakeEventSource[] = [];

class FakeEventSource {
  public static readonly CLOSED = 2;
  public onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();
  public readonly url: string;

  public constructor(url: string | URL) {
    this.url = String(url);
    eventSources.push(this);
  }

  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  public close(): void {}

  public emit(event: AtomicFlowEvent): void {
    this.listeners.get("atomic-flow")?.(
      new MessageEvent("atomic-flow", { data: JSON.stringify(event) }),
    );
  }
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  api.announceBrowserPresence.mockReset();
  api.announceBrowserPresence.mockResolvedValue(undefined);
  api.getRun.mockReset();
  api.listRuns.mockReset();
  eventSources.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("App DOM orchestration", () => {
  it("opens a deep-linked Research Run directly in Trajectory", async () => {
    window.history.replaceState({}, "", "/?runId=run-1&view=trajectory");
    const target = runSummary("completed");
    const latest = {
      ...runSummary("completed"),
      runId: "latest-run",
    };
    api.listRuns.mockResolvedValue([latest, target]);
    api.getRun.mockResolvedValue(runDetail(target, [atomicEvent(1, "end")]));
    const { App } = await import("../src/app.js");
    const container = mount(<App />);
    await flush();

    expect(api.getRun).toHaveBeenCalledWith("run-1");
    expect(api.getRun).not.toHaveBeenCalledWith("latest-run");
    expect(container.textContent).toContain("RUN TRAJECTORY");
    expect(container.querySelector('[role="treeitem"]')).not.toBeNull();
  });

  it("loads a run, receives SSE and drives panels and replay controls", async () => {
    const summary = runSummary("running");
    api.listRuns.mockResolvedValue([summary]);
    api.getRun.mockResolvedValue(runDetail(summary, [atomicEvent(1, "start")]));
    const { App } = await import("../src/app.js");
    const container = mount(<App />);
    await flush();

    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("1 events");
    expect(eventSources[0]?.url).toContain("/api/runs/run-1/events?after=1");
    const topologyNode = clickButton(container, "Runtime Canvas");

    await act(async () => {
      eventSources[0]?.emit(atomicEvent(2, "end"));
    });
    expect(container.textContent).toContain("Event 2 / 2");

    click(container, "Collapse left panel");
    expect(container.textContent).toContain("RUNS");
    click(container, "Expand left panel");
    click(container, "Collapse right panel");
    expect(container.textContent).toContain("EVENTS");
    click(container, "Expand right panel");
    clickText(container, "Trajectory");
    expect(window.localStorage.getItem("yiku:agent-observatory:canvas-view")).toBe("trajectory");
    expect(container.textContent).toContain("RUN TRAJECTORY");
    expect(container.querySelector('[role="treeitem"]')).not.toBeNull();
    expect(clickButton(container, "Runtime Canvas")).toBe(topologyNode);
    act(() =>
      container.querySelector<HTMLButtonElement>(".trajectory-select[aria-pressed=true]")?.click(),
    );
    expect(container.querySelector('button[aria-label="Back to run overview"]')).toBeNull();
    click(container, "Locate current running node");
    clickText(container, "Topology");
    expect(window.localStorage.getItem("yiku:agent-observatory:canvas-view")).toBe("topology");
    expect(clickButton(container, "Runtime Canvas")).toBe(topologyNode);
    clickText(container, "Deep View");
    clickText(container, "Runtime Canvas");
    click(container, "Replay from first event");
    click(container, "Follow live events");

    const workspace = container.querySelector(".studio-workspace");
    act(() => {
      workspace?.dispatchEvent(transitionEvent("grid-template-columns"));
      workspace?.dispatchEvent(transitionEvent("opacity"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(api.getRun).toHaveBeenCalledWith("run-1");
  });

  it("recovers from SSE and request failures", async () => {
    const summary = runSummary("running");
    api.listRuns.mockResolvedValue([summary]);
    api.getRun
      .mockResolvedValueOnce(runDetail(summary, [atomicEvent(1, "start")]))
      .mockRejectedValueOnce("reload failed")
      .mockResolvedValue(runDetail(summary, [atomicEvent(1, "start")]));
    const { App } = await import("../src/app.js");
    const container = mount(<App />);
    await flush();

    await act(async () => {
      eventSources[0]?.onerror?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("reload failed");

    const runButton = [...container.querySelectorAll(".run-history button")][0];
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.getRun).toHaveBeenCalledTimes(3);
  });

  it("selects a projected child Agent while reusing the parent Run", async () => {
    const summary: RunSummary = {
      ...runSummary("completed"),
      agentName: "Code Agent",
      agentSessions: [
        {
          agentId: "child-1",
          agentName: "Reviewer",
          agentSessionId: "session-1.agent.child-1",
          agentType: "code",
          parentSessionId: "session-1",
          status: "succeeded",
          taskId: "task-1",
        },
      ],
      agentType: "code",
      eventCount: 2,
      sessionId: "session-1",
    };
    const events = [atomicEvent(1, "start"), subagentEvent(2)];
    api.listRuns.mockResolvedValue([summary]);
    api.getRun.mockResolvedValue(runDetail(summary, events));
    const { App } = await import("../src/app.js");
    const container = mount(<App />);
    await flush();

    const childButton = container.querySelector<HTMLButtonElement>(".run-history button.is-child");
    await act(async () => {
      childButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getRun).toHaveBeenLastCalledWith("run-1");
    expect(childButton?.className).toContain("is-selected");
    expect(container.textContent).toContain("Reviewer");
  });

  it("renders list request errors", async () => {
    api.listRuns.mockRejectedValue(new Error("runs unavailable"));
    const { App } = await import("../src/app.js");
    const container = mount(<App />);
    await flush();

    expect(container.textContent).toContain("runs unavailable");
  });
});

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLElement, label: string): void {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  act(() => button?.click());
}

function clickText(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function clickButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
}

function transitionEvent(propertyName: string): Event {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  return event;
}

function runSummary(status: RunSummary["status"]): RunSummary {
  return {
    createdAt: "2026-08-07T00:00:00.000Z",
    evalMode: "blocking",
    eventCount: 1,
    projectName: "Workspace",
    prompt: "Inspect runtime",
    runId: "run-1",
    source: "external",
    status,
    updatedAt: "2026-08-07T00:00:01.000Z",
  };
}

function runDetail(summary: RunSummary, events: readonly AtomicFlowEvent[]): RunDetail {
  return {
    ...summary,
    events,
  };
}

function atomicEvent(sequence: number, phase: AtomicFlowEvent["phase"]): AtomicFlowEvent {
  return {
    atom: {
      key: sequence === 1 ? "run" : "loop.turn",
      kind: sequence === 1 ? "input" : "loop",
      label: sequence === 1 ? "Run" : "Loop Turn",
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: { id: `instance-${sequence}` },
    occurredAt: `2026-08-07T00:00:0${sequence}.000Z`,
    phase,
    runId: "run-1",
    sequence,
  };
}

function subagentEvent(sequence: number): AtomicFlowEvent {
  return {
    ...atomicEvent(sequence, "start"),
    atom: {
      key: "subagent.lifecycle",
      kind: "agent",
      label: "Subagent Lifecycle",
      level: "runtime",
    },
    payload: {
      values: {
        agentId: "child-1",
      },
    },
  };
}
