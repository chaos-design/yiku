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

/** Zoom bounds, expressed as an absolute scale (1 = one viewBox unit = 1 css px). */
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
/** Breathing room (css px) kept around the diagram when fitting it to the viewport. */
const FIT_MARGIN = 16;
/** How far a diagram smaller than the viewport may be dragged off-centre. */
const PAN_SLACK = 48;
/** Zoom step for the toolbar buttons and the keyboard shortcuts. */
const STEP = 1.3;
/** Fallback intrinsic size when the SVG carries neither viewBox nor width/height. */
const FALLBACK_SIZE = { w: 1200, h: 800 };

type Size = { w: number; h: number };
type Point = { x: number; y: number };
/** Diagram scale + pan offset (in screen px, applied after scaling). */
type View = { s: number; x: number; y: number };

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
 * The diagram is laid out at its intrinsic size and scaled purely by
 * `transform: scale()`, driven by a single view state `{ s, x, y }`:
 *   - opening fits the whole diagram inside the viewport (contain), so a wide
 *     flowchart fills the screen instead of rendering at container width;
 *   - wheel / pinch / button zoom is anchored at the pointer (or centre), so the
 *     point you look at stays put;
 *   - pan is clamped, so the diagram can never be dragged out of sight;
 *   - "fit" is recomputed from the live viewport box on open and on resize.
 *
 * Every gesture funnels into `zoomAt` / `applyFit`, which share one view ref so
 * rapid input stays smooth and consistent.
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
  const boxRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Latest view kept in a ref so gesture handlers always read fresh values
  // without re-subscribing on every frame; state is mirrored for rendering.
  const viewRef = useRef<View>({ s: 1, x: 0, y: 0 });
  const [view, setView] = useState<View>(viewRef.current);

  const commit = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** Clamp pan so at least a sliver of the diagram stays on screen. */
  const clampPan = useCallback(
    (next: View): View => {
      const vp = viewportRef.current;
      if (!vp) return next;
      const overX = Math.max(0, (next.s * diagram.size.w - vp.clientWidth) / 2);
      const overY = Math.max(0, (next.s * diagram.size.h - vp.clientHeight) / 2);
      return {
        s: next.s,
        x: clampNum(next.x, -(overX + PAN_SLACK), overX + PAN_SLACK),
        y: clampNum(next.y, -(overY + PAN_SLACK), overY + PAN_SLACK),
      };
    },
    [diagram.size.w, diagram.size.h],
  );

  /** Scale that makes the whole diagram fit inside the viewport ("contain"). */
  const computeFit = useCallback((): number => {
    const vp = viewportRef.current;
    if (!vp || diagram.size.w <= 0 || diagram.size.h <= 0) return 1;
    const availW = Math.max(1, vp.clientWidth - FIT_MARGIN * 2);
    const availH = Math.max(1, vp.clientHeight - FIT_MARGIN * 2);
    return clampNum(
      Math.min(availW / diagram.size.w, availH / diagram.size.h),
      MIN_SCALE,
      MAX_SCALE,
    );
  }, [diagram.size.w, diagram.size.h]);

  const applyFit = useCallback(() => {
    commit({ s: computeFit(), x: 0, y: 0 });
  }, [commit, computeFit]);

  /** Zoom by `factor`, keeping the screen point (cx, cy) anchored. */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      // Anchor position relative to the viewport centre (transform-origin).
      const ax = cx - rect.left - rect.width / 2;
      const ay = cy - rect.top - rect.height / 2;
      const v = viewRef.current;
      const s2 = clampNum(v.s * factor, MIN_SCALE, MAX_SCALE);
      const k = s2 / v.s;
      // Solve x' = a - k(a - x) so the anchor point stays fixed on screen.
      commit(clampPan({ s: s2, x: ax - k * (ax - v.x), y: ay - k * (ay - v.y) }));
    },
    [clampPan, commit],
  );

  /** Centre of the viewport, used to anchor button/keyboard-driven zoom. */
  const viewportCenter = useCallback((): [number, number] => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  }, []);

  // Fit as soon as the intrinsic size is known and the viewport is measurable.
  useLayoutEffect(() => {
    applyFit();
  }, [applyFit]);

  // The page behind the dialog must not scroll; hand focus to the dialog on
  // open and restore it on close (accessibility for keyboard users).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lightbox-open");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;
    boxRef.current?.focus({ preventScroll: true });
    return () => {
      root.classList.remove("lightbox-open");
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  // Re-fit (or just re-clamp the pan) when the viewport changes size: rotating
  // a phone or resizing a desktop window must not crop the diagram.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const v = viewRef.current;
        const fit = computeFit();
        // Only re-fit if the user has not zoomed away from the fitted scale;
        // otherwise just re-clamp the pan against the new box.
        const wasFitted = Math.abs(v.s - fit) < 0.02 || v.s <= fit;
        commit(wasFitted ? { s: fit, x: 0, y: 0 } : clampPan(v));
      });
    });
    ro.observe(vp);
    window.addEventListener("orientationchange", () => applyFit());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("orientationchange", applyFit);
    };
  }, [clampPan, commit, computeFit, applyFit]);

  // Keyboard: Esc closes, +/- zoom at centre, 0 fits, arrows pan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        const [cx, cy] = viewportCenter();
        zoomAt(STEP, cx, cy);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const [cx, cy] = viewportCenter();
        zoomAt(1 / STEP, cx, cy);
      } else if (e.key === "0") {
        e.preventDefault();
        applyFit();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = 48;
        const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        const v = viewRef.current;
        commit(clampPan({ s: v.s, x: v.x + dx, y: v.y + dy }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomAt, applyFit, viewportCenter, commit, clampPan]);

  // Wheel must be a non-passive native listener: React's synthetic wheel
  // handler is passive, so `preventDefault()` there would not stop the page
  // from scrolling behind the dialog. An exponential curve keeps the feel
  // consistent whether the input is a mouse (fine ticks) or a trackpad.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 0.05 : 0.0022;
      zoomAt(Math.exp(-e.deltaY * unit), e.clientX, e.clientY);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Pointer bookkeeping: one pointer drags to pan, two pointers pinch-zoom.
  const pointers = useRef(new Map<number, Point>());
  const dragFrom = useRef<Point | null>(null);
  const pinchFrom = useRef<{ distance: number; x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    try {
      // Capture keeps the drag alive when the pointer leaves the viewport. It
      // can throw for synthetic/fast events, which must not break bookkeeping.
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable — panning still works while inside the viewport */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      dragFrom.current = { x: e.clientX, y: e.clientY };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchFrom.current = {
        distance: distance(a, b),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
      dragFrom.current = null;
    }
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const tracked = pointers.current;
      if (!tracked.has(e.pointerId)) return;
      tracked.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (tracked.size >= 2) {
        const [a, b] = [...tracked.values()];
        const dist = distance(a, b);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const prev = pinchFrom.current;
        pinchFrom.current = { distance: dist, x: mid.x, y: mid.y };
        if (!prev || prev.distance <= 0 || dist <= 0) return;
        const vp = viewportRef.current;
        if (!vp) return;
        const rect = vp.getBoundingClientRect();
        const v = viewRef.current;
        const s2 = clampNum(v.s * (dist / prev.distance), MIN_SCALE, MAX_SCALE);
        const k = s2 / v.s;
        const ax = prev.x - rect.left - rect.width / 2;
        const ay = prev.y - rect.top - rect.height / 2;
        commit(
          clampPan({
            s: s2,
            // Zoom about the previous midpoint, then follow the midpoint itself
            // so a two-finger drag also pans.
            x: ax - k * (ax - v.x) + (mid.x - prev.x),
            y: ay - k * (ay - v.y) + (mid.y - prev.y),
          }),
        );
        return;
      }

      const from = dragFrom.current;
      if (!from) return;
      const v = viewRef.current;
      commit(clampPan({ s: v.s, x: v.x + (e.clientX - from.x), y: v.y + (e.clientY - from.y) }));
      dragFrom.current = { x: e.clientX, y: e.clientY };
    },
    [clampPan, commit],
  );

  const endPointer = useCallback((e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    const rest = [...pointers.current.values()][0];
    dragFrom.current = rest ? { x: rest.x, y: rest.y } : null;
  }, []);

  // Double click / double tap toggles between fit and 2× (at the pointer).
  // Bound natively (not a React handler) so the gesture surface stays free of
  // mouse-event attributes — keyboard control runs through the window-level
  // listener instead of a control on the element.
  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      const fit = computeFit();
      if (viewRef.current.s > fit * 1.05) {
        commit({ s: fit, x: 0, y: 0 });
      } else {
        zoomAt(2, e.clientX, e.clientY);
      }
    },
    [commit, computeFit, zoomAt],
  );

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.addEventListener("dblclick", onDoubleClick);
    return () => vp.removeEventListener("dblclick", onDoubleClick);
  }, [onDoubleClick]);

  const percent = Math.round(view.s * 100);
  const stageStyle = {
    width: `${diagram.size.w}px`,
    height: `${diagram.size.h}px`,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
  };

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
      <div className="lightbox-box" ref={boxRef} tabIndex={-1}>
        <div className="lightbox-head">
          <span className="lightbox-title" title={title || t.diagram}>
            {title || t.diagram}
          </span>
          <span className="lightbox-hint">{t.zoomHint}</span>
          <div className="lightbox-tools">
            <button
              type="button"
              className="lightbox-tool lightbox-icon"
              onClick={() => {
                const [cx, cy] = viewportCenter();
                zoomAt(1 / STEP, cx, cy);
              }}
              aria-label={t.zoomOut}
              title={t.zoomOut}
            >
              −
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-fit"
              onClick={applyFit}
              aria-label={t.zoomFit}
              title={t.zoomFit}
            >
              <span className="lightbox-fit-icon" aria-hidden="true">
                ⤢
              </span>
              <span className="lightbox-percent" aria-live="polite">
                {percent}%
              </span>
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-icon"
              onClick={() => {
                const [cx, cy] = viewportCenter();
                zoomAt(STEP, cx, cy);
              }}
              aria-label={t.zoomIn}
              title={t.zoomIn}
            >
              +
            </button>
            <button
              type="button"
              className="lightbox-tool lightbox-icon lightbox-close"
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
            style={stageStyle}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: re-hosts only the site's own mermaid SVG output
            dangerouslySetInnerHTML={{ __html: diagram.html }}
          />
        </div>
      </div>
    </div>
  );
}
