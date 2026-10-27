import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLang } from "./i18n";

/** Zoom bounds, expressed as a multiple of the fit-to-viewport scale. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
/** Zoom step for the toolbar buttons and the keyboard shortcuts. */
const STEP = 1.25;
const WHEEL_STEP = 1.15;
/** Fallback intrinsic size when the SVG carries neither viewBox nor width/height. */
const FALLBACK_SIZE = { w: 1200, h: 800 };

type Size = { w: number; h: number };
type Point = { x: number; y: number };
type View = { zoom: number; x: number; y: number };

const IDENTITY: View = { zoom: 1, x: 0, y: 0 };

function clampNum(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Reads the diagram's intrinsic size and returns markup that is free to fill
 * whatever box the stage gives it.
 *
 * Mermaid emits `width="100%"` plus an inline `max-width`, which would fight
 * the stage: the SVG would keep its natural width and leave a sliver of diagram
 * floating in the middle of the panel. Both are stripped here, and
 * `preserveAspectRatio` is pinned so the vector scales without distortion.
 */
function prepareDiagram(svgHtml: string): { html: string; size: Size } {
  try {
    const parsed = new DOMParser().parseFromString(svgHtml, "image/svg+xml");
    const svg = parsed.documentElement;
    // A malformed SVG parses into a `parsererror` document element, not null.
    if (svg.nodeName.toLowerCase() !== "svg") {
      return { html: svgHtml, size: FALLBACK_SIZE };
    }

    const box = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    const size: Size =
      box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
        ? { w: box[2], h: box[3] }
        : {
            w: Number(svg.getAttribute("width")) || FALLBACK_SIZE.w,
            h: Number(svg.getAttribute("height")) || FALLBACK_SIZE.h,
          };

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    const style = svg.getAttribute("style");
    if (style) svg.setAttribute("style", style.replace(/max-width\s*:[^;]+;?/gi, "").trim());
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    return { html: new XMLSerializer().serializeToString(svg), size };
  } catch {
    return { html: svgHtml, size: FALLBACK_SIZE };
  }
}

/**
 * Click-to-zoom lightbox for document diagrams.
 *
 * The diagram is laid out at its intrinsic size and then scaled by a *fit*
 * factor computed from the live viewport, so opening it always shows the whole
 * diagram inside the available area — on a phone that is the difference between
 * "a corner of a flowchart" and "the flowchart". Zoom multiplies that fit
 * factor, pan is clamped to the diagram so it can never be dragged out of view,
 * and wheel / pinch / drag / keyboard all drive the same view state.
 */
export function Lightbox({
  svgHtml,
  title,
  onClose,
}: {
  svgHtml: string;
  title?: string;
  onClose: () => void;
}) {
  const { t } = useLang();
  const diagram = useMemo(() => prepareDiagram(svgHtml), [svgHtml]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>(IDENTITY);

  // Pointer bookkeeping: one pointer drags, two pointers pinch-zoom.
  const pointers = useRef(new Map<number, Point>());
  const dragFrom = useRef<Point | null>(null);
  const pinchFrom = useRef<{ distance: number; zoom: number } | null>(null);

  // Measure the viewport (and keep measuring: rotating a phone or resizing a
  // desktop window must re-fit instead of cropping the diagram).
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  // The page behind the dialog must not scroll while the diagram is open.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lightbox-open");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      root.classList.remove("lightbox-open");
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Edge margin kept inside the viewport so the diagram never touches the
  // frame; scales with the screen but stays sensible at both extremes.
  const edge = clampNum(viewport.w * 0.03, 6, 24);
  const fit =
    viewport.w > 0 && viewport.h > 0
      ? Math.min(
          Math.max(viewport.w - edge * 2, 40) / diagram.size.w,
          Math.max(viewport.h - edge * 2, 40) / diagram.size.h,
        )
      : 0;
  const scale = (fit > 0 ? fit : 1) * view.zoom;

  // Clamp panning to the diagram's own bounds: at the fit scale there is nothing
  // to pan, so any drag snaps back instead of pushing the diagram off-screen.
  const clampPan = useCallback(
    (next: Point, atScale: number): Point => {
      const maxX = Math.max(0, (diagram.size.w * atScale - viewport.w) / 2);
      const maxY = Math.max(0, (diagram.size.h * atScale - viewport.h) / 2);
      return { x: clampNum(next.x, -maxX, maxX), y: clampNum(next.y, -maxY, maxY) };
    },
    [diagram.size.w, diagram.size.h, viewport.w, viewport.h],
  );

  /**
   * Change the zoom, keeping `anchor` (viewport-relative) fixed. Resolving the
   * next multiplier from the *current* state keeps rapid clicks / wheel ticks
   * additive instead of each one re-applying the same absolute value.
   */
  const applyZoom = useCallback(
    (resolve: (current: number) => number, anchor?: Point) => {
      const base = fit > 0 ? fit : 1;
      setView((current) => {
        const zoom = clampNum(resolve(current.zoom), MIN_ZOOM, MAX_ZOOM);
        if (zoom === current.zoom) return current;
        const ratio = zoom / current.zoom;
        const a = anchor ?? { x: 0, y: 0 };
        const panned = clampPan(
          { x: a.x - (a.x - current.x) * ratio, y: a.y - (a.y - current.y) * ratio },
          base * zoom,
        );
        return { zoom, x: panned.x, y: panned.y };
      });
    },
    [fit, clampPan],
  );

  /** Relative zoom (buttons, wheel, keyboard). */
  const zoomBy = useCallback(
    (factor: number, anchor?: Point) => applyZoom((zoom) => zoom * factor, anchor),
    [applyZoom],
  );

  /** Absolute zoom (pinch, where the gesture start defines the target). */
  const zoomTo = useCallback(
    (target: number, anchor?: Point) => applyZoom(() => target, anchor),
    [applyZoom],
  );

  const reset = useCallback(() => setView(IDENTITY), []);

  // Wheel must be a non-passive native listener: React's synthetic wheel
  // handler is passive, so `preventDefault()` there would not stop the page
  // from scrolling behind the dialog.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, {
        x: e.clientX - (rect.left + rect.width / 2),
        y: e.clientY - (rect.top + rect.height / 2),
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        reset();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = 48;
        const delta =
          e.key === "ArrowLeft"
            ? { x: step, y: 0 }
            : e.key === "ArrowRight"
              ? { x: -step, y: 0 }
              : e.key === "ArrowUp"
                ? { x: 0, y: step }
                : { x: 0, y: -step };
        setView((current) => {
          const panned = clampPan({ x: current.x + delta.x, y: current.y + delta.y }, scale);
          return { ...current, x: panned.x, y: panned.y };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomBy, reset, clampPan, scale]);

  const onPointerDown = (e: ReactPointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      pinchFrom.current = { distance: distance(a, b), zoom: view.zoom };
      dragFrom.current = null;
    } else {
      dragFrom.current = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const tracked = pointers.current;
    if (!tracked.has(e.pointerId)) return;
    tracked.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (tracked.size >= 2) {
      const [a, b] = [...tracked.values()];
      const start = pinchFrom.current;
      const now = distance(a, b);
      if (!start || start.distance <= 0 || now <= 0) return;
      const mid = {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      zoomTo(start.zoom * (now / start.distance), {
        x: mid.x - (rect.left + rect.width / 2),
        y: mid.y - (rect.top + rect.height / 2),
      });
      return;
    }

    const from = dragFrom.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragFrom.current = { x: e.clientX, y: e.clientY };
    setView((current) => {
      const panned = clampPan({ x: current.x + dx, y: current.y + dy }, scale);
      return { ...current, x: panned.x, y: panned.y };
    });
  };

  const endPointer = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    if (pointers.current.size === 0) dragFrom.current = null;
  };

  const zoomLabel = `${Math.round(scale * 100)}%`;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t.zoomTitle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="lightbox-box">
        <div className="lightbox-head">
          <span className="lightbox-title" title={title || t.diagram}>
            {title || t.diagram}
          </span>
          <span className="lightbox-hint">{t.zoomHint}</span>
          <div className="lightbox-tools">
            <button
              type="button"
              className="lightbox-tool"
              onClick={() => zoomBy(1 / STEP)}
              aria-label={t.zoomOut}
              title={t.zoomOut}
            >
              −
            </button>
            <span className="lightbox-zoom" aria-live="polite">
              {zoomLabel}
            </span>
            <button
              type="button"
              className="lightbox-tool"
              onClick={() => zoomBy(STEP)}
              aria-label={t.zoomIn}
              title={t.zoomIn}
            >
              +
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-fit"
              onClick={reset}
              aria-label={t.zoomFit}
              title={t.zoomFit}
            >
              {t.zoomFit}
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-close"
              onClick={onClose}
              aria-label={t.zoomClose}
              title={t.zoomClose}
            >
              ✕
            </button>
          </div>
        </div>
        <div
          className="lightbox-viewport"
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <div
            className="lightbox-stage"
            style={{
              width: `${diagram.size.w}px`,
              height: `${diagram.size.h}px`,
              visibility: viewport.w > 0 ? "visible" : "hidden",
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale})`,
            }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: re-hosts only the site's own mermaid SVG output
            dangerouslySetInnerHTML={{ __html: diagram.html }}
          />
        </div>
      </div>
    </div>
  );
}
