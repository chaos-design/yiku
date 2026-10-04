import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TrajectoryView } from "../../src/components/trajectory-view.js";

describe("TrajectoryView", () => {
  it("renders an industrial hierarchy with status and timing metadata", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryView
        events={[
          event(1, "run", "run-1", "start"),
          event(2, "tool.call", "tool-1", "start", "run-1", 1),
          event(3, "tool.call", "tool-1", "end", "run-1", 1),
        ]}
        onLocateCurrent={vi.fn()}
        onSelectSequence={vi.fn()}
        replaySequence={3}
        selectedSequence={3}
      />,
    );

    expect(markup).toContain("RUN TRAJECTORY");
    expect(markup).toContain("Live execution stream");
    expect(markup).toContain('aria-label="Locate current trajectory step"');
    expect(markup).toContain("Trajectory overview");
    expect(markup).toContain("Turn 1");
    expect(markup).toContain("1 turns");
    expect(markup).toContain("2 steps");
    expect(markup).toContain('role="tree"');
    expect(markup).toContain('aria-level="2"');
    expect(markup).toContain("tool.call");
    expect(markup).toContain('class="trajectory-summary" title=');
    expect(markup).toContain('aria-label="tool.call ·');
    expect(markup).toContain("· 1.00 s");
    expect(markup).toContain("1.00 s");
    expect(markup).toContain("is-selected");
  });

  it("renders a bounded empty state", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryView events={[]} onSelectSequence={vi.fn()} replaySequence={0} />,
    );
    expect(markup).toContain("No trajectory steps");
  });

  it("renders repeated and failed instances", () => {
    const failed = {
      ...event(3, "tool.call", "tool-1", "error", "run-1"),
      payload: { summary: "failed" },
    };
    const markup = renderToStaticMarkup(
      <TrajectoryView
        events={[
          event(1, "run", "run-1", "start"),
          event(2, "tool.call", "tool-1", "start", "run-1"),
          failed,
          event(4, "tool.call", "tool-2", "start", "run-1"),
        ]}
        onSelectSequence={vi.fn()}
        replaySequence={4}
      />,
    );

    expect(markup).toContain("has-failures");
    expect(markup).toContain("1 failed");
    expect(markup).toContain("×2");
    expect(markup).toContain("status-running");
    expect(markup).toContain("trajectory-view is-live has-running-step");
  });

  it("makes long trajectory overviews horizontally scrollable", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryView
        events={Array.from({ length: 30 }, (_, index) =>
          event(index + 1, "tool.call", `tool-${index + 1}`, "end"),
        )}
        onSelectSequence={vi.fn()}
        replaySequence={30}
      />,
    );

    expect(markup).toContain('aria-label="Trajectory overview"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("min-width:1472px");
    expect(markup).toContain("repeat(30, 45px)");
  });
});

function event(
  sequence: number,
  atomKey: string,
  instanceId: string,
  phase: AtomicFlowEvent["phase"],
  parentId?: string,
  iteration?: number,
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
      ...(iteration !== undefined ? { iteration } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
    },
    occurredAt: new Date(sequence * 1_000).toISOString(),
    phase,
    runId: "run",
    sequence,
  };
}
