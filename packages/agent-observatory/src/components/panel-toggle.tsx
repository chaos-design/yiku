import { ChevronLeft, ChevronRight } from "lucide-react";

interface PanelToggleProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly side: "left" | "right";
}

export function PanelToggle({ expanded, onToggle, side }: PanelToggleProps) {
  const pointsLeft = side === "left" ? expanded : !expanded;
  const action = expanded ? "Collapse" : "Expand";

  return (
    <button
      aria-label={`${action} ${side} panel`}
      className={`panel-toggle panel-toggle-${side}`}
      onClick={onToggle}
      title={`${action} ${side} panel`}
      type="button"
    >
      {pointsLeft ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
    </button>
  );
}
