export type CanvasView = "topology" | "trajectory";

const CANVAS_VIEW_STORAGE_KEY = "yiku:agent-observatory:canvas-view";

export function resolveCanvasView(
  search: string,
  storage?: Pick<Storage, "getItem"> | undefined,
): CanvasView {
  const explicitView = new URLSearchParams(search).get("view");
  if (isCanvasView(explicitView)) {
    return explicitView;
  }
  try {
    const storedView = storage?.getItem(CANVAS_VIEW_STORAGE_KEY);
    return isCanvasView(storedView) ? storedView : "topology";
  } catch {
    return "topology";
  }
}

export function storeCanvasView(
  view: CanvasView,
  storage?: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(CANVAS_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function isCanvasView(value: string | null | undefined): value is CanvasView {
  return value === "topology" || value === "trajectory";
}
