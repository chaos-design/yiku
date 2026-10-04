import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AtomicLog,
  eventSearchText,
  formatEventTime,
  isLogEvent,
  logScrollState,
  nextLogSelection,
} from "../../src/components/atomic-log.js";

describe("AtomicLog", () => {
  it("renders newest events first with split timestamps and search", () => {
    const markup = renderToStaticMarkup(
      <AtomicLog
        events={[atomicEvent(1, "input.prompt"), atomicEvent(2, "loop.turn", true)]}
        onSelect={vi.fn()}
        playing={false}
        selectedSequence={1}
      />,
    );

    expect(markup).toContain(">LOG<");
    expect(markup).toContain('class="atomic-log-heading"');
    expect(markup).not.toContain("ATOMIC LOG");
    expect(markup).not.toContain('aria-label="Scroll atomic log to top"');
    expect(markup).not.toContain('aria-label="Scroll atomic log to bottom"');
    expect(markup).toContain('aria-label="Search atomic log"');
    expect(markup).toContain('placeholder="Search tools or text"');
    expect(markup).toContain('dateTime="2026-08-01T12:34:56.789Z"');
    const timestamp = formatEventTime("2026-08-01T12:34:56.789Z");
    expect(markup).toContain(timestamp.date);
    expect(markup).toContain(timestamp.time);
    expect(markup.indexOf("loop.turn")).toBeLessThan(markup.indexOf("input.prompt"));
    expect(markup).not.toContain(">T1<");
    expect(markup.match(/>turn 1</gu)).toHaveLength(1);
    expect(markup).toContain("is-internal");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("Filter atoms");
  });

  it("renders one trailing marker for each turn in reverse chronological order", () => {
    const markup = renderToStaticMarkup(
      <AtomicLog
        events={[
          atomicEvent(1, "input.prompt"),
          atomicEvent(2, "tool.x", false, "tool", 1),
          atomicEvent(3, "tool.y", false, "tool", 1),
          atomicEvent(4, "tool.turn-2", false, "tool", 2),
        ]}
        onSelect={vi.fn()}
        playing={false}
      />,
    );

    expect(markup.match(/class="log-turn-marker"/gu)).toHaveLength(2);
    expect(markup.match(/>turn 1</gu)).toHaveLength(1);
    expect(markup.match(/>turn 2</gu)).toHaveLength(1);
    expect(markup.indexOf("tool.turn-2")).toBeLessThan(markup.indexOf(">turn 2<"));
    expect(markup.indexOf(">turn 2<")).toBeLessThan(markup.indexOf("tool.y"));
    expect(markup.indexOf("tool.y")).toBeLessThan(markup.indexOf("tool.x"));
    expect(markup.indexOf("tool.x")).toBeLessThan(markup.indexOf(">turn 1<"));
  });

  it("selects an inactive event and clears the active event", () => {
    expect(nextLogSelection(undefined, 3)).toBe(3);
    expect(nextLogSelection(2, 3)).toBe(3);
    expect(nextLogSelection(3, 3)).toBeUndefined();
  });

  it("derives available scroll directions from list geometry", () => {
    expect(logScrollState({ clientHeight: 100, scrollHeight: 100, scrollTop: 0 })).toEqual({
      canScrollDown: false,
      canScrollUp: false,
    });
    expect(logScrollState({ clientHeight: 100, scrollHeight: 300, scrollTop: 0 })).toEqual({
      canScrollDown: true,
      canScrollUp: false,
    });
    expect(logScrollState({ clientHeight: 100, scrollHeight: 300, scrollTop: 100 })).toEqual({
      canScrollDown: true,
      canScrollUp: true,
    });
    expect(logScrollState({ clientHeight: 100, scrollHeight: 300, scrollTop: 200 })).toEqual({
      canScrollDown: false,
      canScrollUp: true,
    });
  });

  it("indexes tool names and payload text for search", () => {
    const event = {
      ...atomicEvent(1, "tool.call"),
      atom: {
        ...atomicEvent(1, "tool.call").atom,
        kind: "tool" as const,
      },
      payload: {
        summary: "Read package manifest",
        values: {
          toolName: "bashTerminal",
        },
      },
    };

    expect(eventSearchText(event)).toContain("tool.call");
    expect(eventSearchText(event)).toContain("read package manifest");
    expect(eventSearchText(event)).toContain("bashterminal");
  });

  it("keeps Trace and Trajectory events out of the functional log", () => {
    const trace = atomicEvent(2, "trace.append", false, "trace");
    const trajectory = atomicEvent(3, "trajectory.project", false, "trajectory");
    const markup = renderToStaticMarkup(
      <AtomicLog
        events={[atomicEvent(1, "tool.call"), trace, trajectory]}
        onSelect={vi.fn()}
        playing={false}
      />,
    );

    expect(isLogEvent(trace)).toBe(false);
    expect(isLogEvent(trajectory)).toBe(false);
    expect(markup).toContain("tool.call");
    expect(markup).not.toContain("trace.append");
    expect(markup).not.toContain("trajectory.project");
  });
});

function atomicEvent(
  sequence: number,
  atomKey: string,
  internal = false,
  kind: AtomicFlowEvent["atom"]["kind"] = "loop",
  iteration?: number,
): AtomicFlowEvent {
  return {
    atom: {
      key: atomKey,
      kind,
      label: "Loop Turn",
      level: "runtime",
    },
    eventId: `event-${sequence}`,
    instance: {
      id: `instance-${sequence}`,
      ...(iteration !== undefined ? { iteration } : {}),
    },
    ...(internal ? { internal: true } : {}),
    occurredAt: "2026-08-01T12:34:56.789Z",
    phase: "start",
    runId: "run-1",
    sequence,
  };
}
