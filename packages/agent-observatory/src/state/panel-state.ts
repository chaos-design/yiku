export type PanelBand = "medium" | "narrow" | "wide";

export interface PanelState {
  readonly band: PanelBand;
  readonly leftExpanded: boolean;
  readonly rightExpanded: boolean;
}

export function panelStateForWidth(width: number): PanelState {
  const band = panelBandForWidth(width);
  return {
    band,
    leftExpanded: band !== "narrow",
    rightExpanded: true,
  };
}

export function updatePanelWidth(state: PanelState, width: number): PanelState {
  const nextBand = panelBandForWidth(width);
  return nextBand === state.band ? state : panelStateForWidth(width);
}

export function togglePanel(state: PanelState, side: "left" | "right"): PanelState {
  return side === "left"
    ? {
        ...state,
        leftExpanded: !state.leftExpanded,
      }
    : {
        ...state,
        rightExpanded: !state.rightExpanded,
      };
}

function panelBandForWidth(width: number): PanelBand {
  if (width <= 800) {
    return "narrow";
  }
  if (width <= 1180) {
    return "medium";
  }
  return "wide";
}
