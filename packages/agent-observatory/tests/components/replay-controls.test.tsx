import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReplayControls } from "../../src/components/replay-controls.js";

describe("ReplayControls", () => {
  it("uses icon-only replay actions with hover labels", () => {
    const markup = renderToStaticMarkup(
      <ReplayControls
        eventCount={3}
        eventPosition={1}
        live={false}
        onLive={vi.fn()}
        onPlayingChange={vi.fn()}
        onSeek={vi.fn()}
        playing={false}
      />,
    );

    expect(markup).toContain('data-tooltip="Replay from start"');
    expect(markup).toContain('data-tooltip="Previous event"');
    expect(markup).toContain('data-tooltip="Play replay"');
    expect(markup).toContain('data-tooltip="Next event"');
    expect(markup).not.toContain("button-label");
  });
});
