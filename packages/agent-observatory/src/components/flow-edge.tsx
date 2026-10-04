import type { RoutedFlowEdge } from "../data/flow-layout.js";
import type { EdgeRuntimeView } from "../state/flow-selectors.js";

interface FlowEdgesProps {
  readonly edges: readonly RoutedFlowEdge[];
  readonly edgeViews: ReadonlyMap<string, EdgeRuntimeView>;
  readonly height: number;
  readonly width: number;
}

const EDGE_MARKERS = {
  active: "#c4b5fd",
  complete: "#2dd4bf",
  data: "#38bdf8",
  execution: "#64748b",
  feedback: "#94a3b8",
  hover: "#ecfeff",
  persistence: "#818cf8",
  selected: "#ecfeff",
} as const;

export function FlowEdges({ edges, edgeViews, height, width }: FlowEdgesProps) {
  const presentations = edges.map((route) => {
    const view = edgeViews.get(route.key);
    const active = view?.active === true;
    const completed = view?.completed === true;
    const flowing = view?.flowing === true;
    const selected = view?.selected === true;
    const trajectoryFlow = route.to === "trajectory.project";
    const classes = `edge edge-${route.kind}${active ? " is-active" : ""}${
      completed ? " is-complete" : ""
    }${flowing ? " is-flowing" : ""}${selected ? " is-selected" : ""}${
      trajectoryFlow ? " is-trajectory-flow" : ""
    }`;
    const marker = selected
      ? "selected"
      : flowing || active
        ? "active"
        : completed
          ? "complete"
          : route.kind;
    return {
      active,
      classes,
      duration: Math.min(2.6, Math.max(0.9, route.length / 180)) * (trajectoryFlow ? 2 : 1),
      emphasized: active || flowing || selected,
      flowing,
      marker,
      route,
      trajectoryFlow,
    };
  });
  const orderedPresentations = presentations.toSorted(
    (left, right) => Number(left.emphasized) - Number(right.emphasized),
  );

  return (
    <svg aria-hidden="true" className="flow-edges" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        {Object.entries(EDGE_MARKERS).map(([id, fill]) => (
          <marker
            id={`edge-arrow-${id}`}
            key={id}
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            markerWidth="9"
            orient="auto"
            overflow="visible"
            refX="9"
            refY="4.5"
            viewBox="0 0 9 9"
          >
            <path d="M0 0.5L9 4.5L0 8.5Z" fill={fill} />
          </marker>
        ))}
      </defs>

      <g className="edge-track-layer">
        {presentations.map(({ route }) => (
          <path
            className="edge-track"
            d={route.path}
            data-edge-key={route.key}
            key={route.key}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>

      <g className="edge-glow-layer">
        {presentations.flatMap(({ flowing, route, trajectoryFlow }) =>
          flowing
            ? [
                <path
                  className={`edge-glow${trajectoryFlow ? " is-trajectory-flow" : ""}`}
                  d={route.path}
                  data-edge-key={route.key}
                  key={route.key}
                  vectorEffect="non-scaling-stroke"
                />,
              ]
            : [],
        )}
      </g>

      <g className="edge-line-layer">
        {orderedPresentations.map(({ classes, emphasized, marker, route }) => (
          <g
            className="edge-route"
            data-edge-key={route.key}
            data-from={route.from}
            data-to={route.to}
            key={route.key}
          >
            <path
              className="edge-hit-target"
              d={route.path}
              data-edge-key={route.key}
              vectorEffect="non-scaling-stroke"
            />
            <path className="edge-casing" d={route.path} vectorEffect="non-scaling-stroke" />
            <path
              className={classes}
              d={route.path}
              data-edge-key={route.key}
              data-from={route.from}
              data-to={route.to}
              markerEnd={`url(#edge-arrow-${marker})`}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="edge-hover-overlay"
              d={route.path}
              markerEnd="url(#edge-arrow-hover)"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              className={`edge-port edge-port-${route.kind}${emphasized ? " is-emphasized" : ""}`}
              cx={route.startPoint.x}
              cy={route.startPoint.y}
              data-edge-key={route.key}
              r="3"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </g>

      <g className="edge-flow-layer">
        {presentations.flatMap(({ flowing, route, trajectoryFlow }) =>
          flowing
            ? [
                <path
                  className={`edge-flow-beam${trajectoryFlow ? " is-trajectory-flow" : ""}`}
                  d={route.path}
                  data-edge-key={route.key}
                  key={`${route.key}:beam`}
                  pathLength="1"
                  vectorEffect="non-scaling-stroke"
                />,
                <circle
                  className={`edge-target-pulse${trajectoryFlow ? " is-trajectory-flow" : ""}`}
                  cx={route.endPoint.x}
                  cy={route.endPoint.y}
                  data-edge-key={route.key}
                  key={`${route.key}:target`}
                  r="3.2"
                  vectorEffect="non-scaling-stroke"
                />,
              ]
            : [],
        )}
      </g>

      <g className="edge-particle-layer">
        {presentations.flatMap(({ duration, flowing, route, trajectoryFlow }) =>
          flowing
            ? [0, 1, 2].map((particle) => (
                <circle
                  className={`flow-particle${trajectoryFlow ? " is-trajectory-flow" : ""}`}
                  data-edge-key={route.key}
                  key={`${route.key}:${particle}`}
                  r={particle === 0 ? 3 : 2}
                >
                  <animateMotion
                    begin={`${particle * -(duration / 3)}s`}
                    dur={`${duration}s`}
                    path={route.path}
                    repeatCount="indefinite"
                  />
                </circle>
              ))
            : [],
        )}
      </g>
    </svg>
  );
}
