export type { FlowGraphErrorCode, FlowGraphErrorOptions } from "./errors.js";
export { FlowGraphError } from "./errors.js";
export type { GraphSegment, SegmentRelation } from "./geometry.js";
export {
  compactOrthogonalPoints,
  expandRect,
  isOrthogonalRoute,
  isOrthogonalSegment,
  parallelProximity,
  pointInsideRect,
  rectBottom,
  rectRight,
  routeIntersectsRect,
  routeLength,
  segmentIntersectsRectInterior,
  segmentRelation,
  toSegments,
} from "./geometry.js";
export { OrthogonalRouter } from "./orthogonal-router.js";
export { offsetOrthogonalRoute } from "./segment-offset.js";
export { toRoundedSvgPath } from "./svg-path.js";
export type {
  FlowGraphInput,
  FlowGraphMetrics,
  FlowGraphResult,
  GraphEdge,
  GraphEndpoint,
  GraphNode,
  GraphObstacle,
  GraphPoint,
  GraphRect,
  OrthogonalRouterOptions,
  PortConstraint,
  PortMode,
  PortSide,
  ResolvedPort,
  RouteDiagnostic,
  RouteDiagnosticCode,
  RoutedGraphEdge,
  RouteMetrics,
  SegmentOffsets,
} from "./types.js";
