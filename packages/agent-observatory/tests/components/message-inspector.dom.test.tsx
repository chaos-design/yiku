// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageInspector } from "../../src/components/message-inspector.js";
import type { RunDetail } from "../../src/types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("MessageInspector DOM", () => {
  it("defaults to expanded and persists a manually collapsed scorecard", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<MessageInspector run={runDetail()} />));

    const region = container.querySelector<HTMLElement>("#run-evaluation-scorecard");
    expect(region?.getAttribute("aria-hidden")).toBe("false");
    expect(region?.classList.contains("is-expanded")).toBe(true);

    click(container, "Collapse quality gate scorecard");
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    expect(region?.classList.contains("is-expanded")).toBe(false);
    expect(container.querySelector('[aria-expanded="false"]')).not.toBeNull();
    expect(localStorage.getItem("yiku:agent-observatory:scorecard-collapsed")).toBe("true");

    act(() => root.unmount());

    const restoredContainer = document.createElement("div");
    const restoredRoot = createRoot(restoredContainer);
    act(() => restoredRoot.render(<MessageInspector run={runDetail()} />));
    const restoredRegion = restoredContainer.querySelector<HTMLElement>(
      "#run-evaluation-scorecard",
    );
    expect(restoredRegion?.getAttribute("aria-hidden")).toBe("true");
    expect(restoredRegion?.classList.contains("is-expanded")).toBe(false);

    click(restoredContainer, "Expand quality gate scorecard");
    expect(restoredRegion?.getAttribute("aria-hidden")).toBe("false");
    expect(localStorage.getItem("yiku:agent-observatory:scorecard-collapsed")).toBeNull();

    act(() => restoredRoot.unmount());
  });
});

function click(container: HTMLElement, label: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
  });
}

function runDetail(): RunDetail {
  return {
    createdAt: "2026-08-01T12:00:00.000Z",
    evalMode: "blocking",
    eventCount: 0,
    events: [],
    prompt: "Prompt",
    runId: "run-1",
    scorecard: {
      averageScore: 1,
      passed: true,
      results: [],
    },
    source: "studio",
    status: "accepted",
    updatedAt: "2026-08-01T12:00:01.000Z",
  };
}
