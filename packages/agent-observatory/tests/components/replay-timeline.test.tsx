import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReplayTimeline } from "../../src/components/replay-timeline.js";

describe("ReplayTimeline", () => {
  it("renders functional event positions instead of raw sequences", () => {
    const markup = renderToStaticMarkup(
      <ReplayTimeline eventCount={2} eventPosition={1} onSeek={vi.fn()} />,
    );

    expect(markup).toContain("Event 1 / 2");
    expect(markup).toContain('max="2"');
    expect(markup).not.toContain("Event 1 / 5");
  });
});
