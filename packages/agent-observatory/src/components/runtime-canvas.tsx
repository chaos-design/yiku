import type { AtomicDefinition, AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ATOMS, dynamicAtomLayouts, type EdgeLayout, edgeLayoutKey } from "../data/atom-layout.js";
import type { FlowLayout } from "../data/flow-layout.js";
import { FlowLayoutClient } from "../data/flow-layout-client.js";
import type { AtomRuntimeView, EdgeRuntimeView } from "../state/flow-selectors.js";
import { AtomNode } from "./atom-node.js";
import { DomainZone } from "./domain-zone.js";
import { FlowEdges } from "./flow-edge.js";
import { TooltipProvider } from "./ui/tooltip.js";

const layoutClient = new FlowLayoutClient();
const CANVAS_INSET = 12;
const MAX_CANVAS_SCALE = 1.15;
const PREPARING_EXIT_MS = 200;

interface RuntimeCanvasProps {
  readonly atomDefinitions: readonly AtomicDefinition[];
  readonly atomViews: ReadonlyMap<string, AtomRuntimeView>;
  readonly deepView: boolean;
  readonly edges: readonly EdgeLayout[];
  readonly edgeViews: ReadonlyMap<string, EdgeRuntimeView>;
  readonly executionActive: boolean;
  readonly layoutReady: boolean;
  readonly layoutKey: string;
  readonly locateAtomKey?: string | undefined;
  readonly locateRequest?: number | undefined;
  readonly onSelectSequence: (sequence: number) => void;
  readonly observedAtomKeys: ReadonlySet<string>;
  readonly selectedEvent?: AtomicFlowEvent | undefined;
}

export function RuntimeCanvas({
  atomDefinitions,
  atomViews,
  deepView,
  edges,
  edgeViews,
  executionActive,
  layoutReady,
  layoutKey,
  locateAtomKey,
  locateRequest = 0,
  onSelectSequence,
  observedAtomKeys,
  selectedEvent,
}: RuntimeCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const locateRequestRef = useRef(locateRequest);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [flowLayout, setFlowLayout] = useState<FlowLayout>();
  const [layoutError, setLayoutError] = useState("");
  const [layoutPending, setLayoutPending] = useState(true);
  const [preparingExiting, setPreparingExiting] = useState(false);
  const [preparingVisible, setPreparingVisible] = useState(true);
  const layoutCacheRef = useRef(new Map<string, Promise<FlowLayout>>());
  const initialLayoutResolvedRef = useRef(false);
  const preparingExitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allAtoms = useMemo(
    () => [...ATOMS, ...dynamicAtomLayouts(atomDefinitions)],
    [atomDefinitions],
  );
  const visibleAtoms = useMemo(
    () => (deepView ? allAtoms : allAtoms.filter((atom) => atom.level === "runtime")),
    [allAtoms, deepView],
  );
  const visibleEdges = useMemo(() => {
    const visibleKeys = new Set(visibleAtoms.map((atom) => atom.key));
    return edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to));
  }, [edges, visibleAtoms]);
  const graphKey = useMemo(
    () =>
      `${visibleAtoms.map((atom) => atom.key).join("|")}::${visibleEdges
        .map(edgeLayoutKey)
        .join("|")}`,
    [visibleAtoms, visibleEdges],
  );
  const graphInputRef = useRef({
    atoms: visibleAtoms,
    edges: visibleEdges,
    key: graphKey,
  });
  graphInputRef.current = {
    atoms: visibleAtoms,
    edges: visibleEdges,
    key: graphKey,
  };
  const canvasWidth = flowLayout?.width ?? 0;
  const canvasHeight = flowLayout?.height ?? 0;
  const scale = canvasContainScale(canvasWidth, canvasHeight, viewport.width, viewport.height);
  const scaledWidth = canvasWidth * scale;
  const scaledHeight = canvasHeight * scale;
  const availableHeight = Math.max(0, viewport.height - CANVAS_INSET * 2);
  const verticalOffset = Math.max(0, (availableHeight - scaledHeight) / 2);

  useEffect(() => {
    if (!layoutReady) {
      return;
    }
    let active = true;
    const graphInput = graphInputRef.current;
    if (graphInput.key !== graphKey) {
      return;
    }
    setLayoutPending(true);
    setLayoutError("");
    let layoutPromise = layoutCacheRef.current.get(graphKey);
    if (layoutPromise === undefined) {
      layoutPromise = layoutClient.layout(graphInput.atoms, graphInput.edges);
      layoutCacheRef.current.set(graphKey, layoutPromise);
      void layoutPromise.catch(() => {
        if (layoutCacheRef.current.get(graphKey) === layoutPromise) {
          layoutCacheRef.current.delete(graphKey);
        }
      });
    }
    void layoutPromise
      .then((layout) => {
        if (active) {
          setFlowLayout(layout);
          setLayoutPending(false);
          if (!initialLayoutResolvedRef.current) {
            initialLayoutResolvedRef.current = true;
            setPreparingExiting(true);
            preparingExitTimerRef.current = setTimeout(() => {
              preparingExitTimerRef.current = undefined;
              setPreparingVisible(false);
            }, PREPARING_EXIT_MS);
          }
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setLayoutError(cause instanceof Error ? cause.message : String(cause));
          setLayoutPending(false);
          if (!initialLayoutResolvedRef.current) {
            initialLayoutResolvedRef.current = true;
            setPreparingVisible(false);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [graphKey, layoutReady]);

  useEffect(
    () => () => {
      if (preparingExitTimerRef.current !== undefined) {
        clearTimeout(preparingExitTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (
      locateRequestRef.current === locateRequest ||
      !layoutReady ||
      flowLayout === undefined ||
      locateAtomKey === undefined
    ) {
      return;
    }
    locateRequestRef.current = locateRequest;
    const atom = [
      ...(viewportRef.current?.querySelectorAll<HTMLButtonElement>("[data-atom-key]") ?? []),
    ].find((candidate) => candidate.dataset.atomKey === locateAtomKey);
    atom?.focus({ preventScroll: true });
  }, [flowLayout, layoutReady, locateAtomKey, locateRequest]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) {
      return;
    }
    element.dataset.layoutKey = layoutKey;
    element.dataset.canvasSize = `${canvasWidth}:${canvasHeight}`;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setViewport((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : {
              height: bounds.height,
              width: bounds.width,
            },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    let frame = 0;
    let remainingFrames = 24;
    const trackTransition = () => {
      measure();
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        frame = window.requestAnimationFrame(trackTransition);
      }
    };
    frame = window.requestAnimationFrame(trackTransition);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [canvasHeight, canvasWidth, layoutKey]);

  return (
    <div
      aria-busy={layoutPending}
      className="runtime-canvas-viewport"
      data-canvas-scale={scale}
      data-layout-state={
        layoutPending
          ? flowLayout === undefined
            ? "preparing"
            : "reflowing"
          : layoutError
            ? "error"
            : "ready"
      }
      data-measured-height={viewport.height}
      data-measured-width={viewport.width}
      ref={viewportRef}
    >
      {flowLayout === undefined && layoutError ? (
        <div className="runtime-canvas-loading is-error" role="status">
          {layoutError}
        </div>
      ) : (
        <>
          {preparingVisible ? (
            <div
              className={`runtime-canvas-preparing${preparingExiting ? " is-exiting" : ""}`}
              role="status"
            >
              <span className="runtime-canvas-status-copy">Preparing flow layout</span>
              <svg
                aria-hidden="true"
                className="runtime-canvas-preparing-topology"
                viewBox="0 0 760 320"
              >
                <g className="flow-skeleton-edge is-phase-2">
                  <path d="M142 160 H244" />
                </g>
                <g className="flow-skeleton-edge is-phase-3">
                  <path d="M332 160 H410" />
                  <path d="M332 160 C368 160 370 244 410 244" />
                </g>
                <g className="flow-skeleton-edge is-phase-4">
                  <path d="M512 160 H618" />
                  <path d="M512 244 C560 244 568 160 618 160" />
                </g>
                <g className="flow-skeleton-node is-input is-phase-1" transform="translate(54 132)">
                  <rect height="56" rx="7" width="88" />
                  <circle cx="15" cy="28" r="4" />
                  <text x="28" y="33">
                    INPUT
                  </text>
                </g>
                <g
                  className="flow-skeleton-node is-route is-phase-2"
                  transform="translate(244 132)"
                >
                  <rect height="56" rx="7" width="88" />
                  <circle cx="15" cy="28" r="4" />
                  <text x="28" y="33">
                    ROUTE
                  </text>
                </g>
                <g
                  className="flow-skeleton-node is-runtime is-phase-3"
                  transform="translate(410 132)"
                >
                  <rect height="56" rx="7" width="102" />
                  <circle cx="15" cy="28" r="4" />
                  <text x="28" y="33">
                    RUNTIME
                  </text>
                </g>
                <g className="flow-skeleton-node is-tool is-phase-3" transform="translate(410 216)">
                  <rect height="56" rx="7" width="102" />
                  <circle cx="15" cy="28" r="4" />
                  <text x="28" y="33">
                    TOOL
                  </text>
                </g>
                <g
                  className="flow-skeleton-node is-output is-phase-4"
                  transform="translate(618 132)"
                >
                  <rect height="56" rx="7" width="88" />
                  <circle cx="15" cy="28" r="4" />
                  <text x="28" y="33">
                    OUTPUT
                  </text>
                </g>
              </svg>
            </div>
          ) : null}
          {flowLayout === undefined ? null : (
            <>
              <div
                className={`runtime-canvas-fit${layoutPending ? " is-reflowing" : ""}${
                  preparingVisible ? " is-entering" : ""
                }`}
                style={{
                  height: scaledHeight,
                  marginTop: verticalOffset,
                  width: scaledWidth,
                }}
              >
                <div
                  className="runtime-canvas"
                  style={{
                    height: canvasHeight,
                    transform: `scale(${scale})`,
                    width: canvasWidth,
                  }}
                >
                  {flowLayout.domains.map((domain) => (
                    <DomainZone domain={domain} key={domain.key} />
                  ))}
                  <FlowEdges
                    edges={flowLayout.edges}
                    edgeViews={edgeViews}
                    height={canvasHeight}
                    width={canvasWidth}
                  />
                  <TooltipProvider>
                    {flowLayout.atoms.map((atom) => (
                      <AtomNode
                        atom={atom}
                        executionActive={executionActive}
                        key={atom.key}
                        observed={observedAtomKeys.has(atom.key)}
                        onSelect={onSelectSequence}
                        selected={selectedEvent?.atom.key === atom.key}
                        view={atomViews.get(atom.key)}
                      />
                    ))}
                  </TooltipProvider>
                </div>
              </div>
              {layoutPending ? (
                <div className="runtime-canvas-routing-indicator" role="status">
                  <span className="runtime-canvas-status-copy">Updating flow layout</span>
                  <span aria-hidden="true">
                    <i />
                    <i className="is-delayed" />
                    <i className="is-delayed-more" />
                  </span>
                </div>
              ) : null}
              {layoutError ? (
                <div className="runtime-canvas-refresh-error" role="alert">
                  {layoutError}
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function canvasContainScale(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (canvasWidth <= 0 || canvasHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }
  const availableWidth = Math.max(1, viewportWidth - CANVAS_INSET * 2);
  const availableHeight = Math.max(1, viewportHeight - CANVAS_INSET * 2);
  return Math.min(MAX_CANVAS_SCALE, availableWidth / canvasWidth, availableHeight / canvasHeight);
}
