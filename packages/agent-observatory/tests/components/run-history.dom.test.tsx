// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHistory } from "../../src/components/run-history.js";

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

describe("RunHistory DOM", () => {
  it("shows complete run details through the shadcn tooltip on hover", async () => {
    act(() =>
      root.render(
        <RunHistory
          onSelect={() => undefined}
          runs={[
            {
              agentKey: "code",
              agentName: "Code Agent",
              agentType: "code",
              createdAt: "2026-08-04T08:30:00",
              evalMode: "blocking",
              eventCount: 12,
              kind: "control",
              projectName: "workspace",
              prompt: "A complete prompt that is longer than the history row",
              runId: "run-987654321",
              sessionId: "session-1",
              source: "external",
              status: "completed",
              updatedAt: "2026-08-04T08:31:00.000Z",
            },
          ]}
        />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger?.hasAttribute("title")).toBe(false);
    const rowContent = Array.from(
      trigger?.querySelectorAll("strong, .run-history-meta-row") ?? [],
      (element) => element.textContent,
    );
    expect(rowContent).toEqual([
      "A complete prompt that is longer than the history row",
      "2026-08-04 08:30:00 · CONTROL",
      "workspace · run-98765432 · 12 events",
    ]);
    expect(
      Array.from(
        trigger?.querySelectorAll(".run-history-agent-tag") ?? [],
        (element) => element.textContent,
      ),
    ).toEqual(["Agent NameCode Agent", "Typecode", "Sessionsession-1"]);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    const content = document.body.querySelector('[data-slot="tooltip-content"]');
    const tooltipContent = Array.from(
      content?.querySelector(".run-history-tooltip")?.children ?? [],
      (element) => element.textContent,
    );
    expect(tooltipContent).toEqual([
      "A complete prompt that is longer than the history row",
      "2026-08-04 08:30:00 · CONTROL",
      "Agent NameCode AgentTypecodeSessionsession-1",
      "workspace · run-98765432 · 12 events",
    ]);
    expect(content?.querySelectorAll(".run-history-agent-tag")).toHaveLength(3);
    expect(content?.textContent).not.toContain("completed");
    expect(content?.textContent).not.toContain("external");
    expect(content?.textContent).toContain("Agent NameCode Agent");
    expect(content?.textContent).toContain("Typecode");
    expect(content?.textContent).not.toContain("2026-08-04T08:31:00.000Z");
  });
});
