import { describe, expect, it } from "vitest";
import { panelStateForWidth, togglePanel, updatePanelWidth } from "../../src/state/panel-state.js";

describe("panel state", () => {
  it("uses responsive defaults for wide, medium, and narrow viewports", () => {
    expect(panelStateForWidth(1440)).toEqual({
      band: "wide",
      leftExpanded: true,
      rightExpanded: true,
    });
    expect(panelStateForWidth(1024)).toEqual({
      band: "medium",
      leftExpanded: true,
      rightExpanded: true,
    });
    expect(panelStateForWidth(375)).toEqual({
      band: "narrow",
      leftExpanded: false,
      rightExpanded: true,
    });
  });

  it("preserves manual state within a band and resets defaults across bands", () => {
    const collapsed = togglePanel(panelStateForWidth(1440), "left");
    expect(updatePanelWidth(collapsed, 1300)).toBe(collapsed);
    expect(updatePanelWidth(collapsed, 1024)).toEqual({
      band: "medium",
      leftExpanded: true,
      rightExpanded: true,
    });
  });

  it("toggles both panels independently", () => {
    const state = panelStateForWidth(1024);
    const right = togglePanel(state, "right");
    const left = togglePanel(right, "left");

    expect(left).toMatchObject({
      leftExpanded: false,
      rightExpanded: false,
    });
  });
});
