export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

export type SegmentOffsets = Readonly<Record<number, number>>;

export interface GraphRect extends GraphPoint {
  readonly height: number;
  readonly width: number;
}

export type PortSide = "bottom" | "left" | "right" | "top";
export type PortMode = "fixed" | "preferred";

export interface PortConstraint {
  readonly mode?: PortMode | undefined;
  readonly side?: PortSide | undefined;
  readonly slot?: number | undefined;
}

export interface GraphEndpoint {
  readonly nodeId: string;
  readonly port?: PortConstraint | undefined;
}

export interface GraphNode {
  readonly bounds: GraphRect;
  readonly id: string;
}

export interface GraphObstacle {
  readonly bounds: GraphRect;
  readonly id: string;
  readonly padding?: number | undefined;
}

export interface GraphEdge {
  readonly id: string;
  readonly routeBounds?: GraphRect | undefined;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

export interface FlowGraphInput {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly GraphNode[];
  readonly obstacles?: readonly GraphObstacle[] | undefined;
}

export interface OrthogonalRouterOptions {
  readonly bendPenalty?: number | undefined;
  readonly clearance?: number | undefined;
  readonly crossingPenalty?: number | undefined;
  readonly maxCoordinatesPerAxis?: number | undefined;
  readonly maxEdges?: number | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxOptimizationPasses?: number | undefined;
  readonly overlapPenalty?: number | undefined;
  readonly parallelGap?: number | undefined;
  readonly portDeviationPenalty?: number | undefined;
  readonly portStubLength?: number | undefined;
  readonly proximityPenalty?: number | undefined;
  readonly roundingRadius?: number | undefined;
}

export interface ResolvedPort {
  readonly exit: GraphPoint;
  readonly point: GraphPoint;
  readonly side: PortSide;
  readonly slot: number;
}

export interface RouteMetrics {
  readonly bends: number;
  readonly collisions: number;
  readonly crossings: number;
  readonly length: number;
  readonly overlap: number;
  readonly portDeviation: number;
  readonly proximity: number;
}

export interface FlowGraphMetrics extends RouteMetrics {
  readonly fallbackCount: number;
  readonly optimizationPasses: number;
  readonly routeCount: number;
}

export type RouteDiagnosticCode =
  | "ROUTE_COLLISION_FALLBACK"
  | "ROUTE_CROSSING_REMAINS"
  | "ROUTE_OPTIMIZATION_LIMIT"
  | "ROUTE_OVERLAP_REMAINS"
  | "ROUTE_PORT_REUSED_BY_CONSTRAINT"
  | "ROUTE_PROXIMITY_REMAINS";

export interface RouteDiagnostic {
  readonly code: RouteDiagnosticCode;
  readonly edgeId?: string | undefined;
  readonly message: string;
  readonly relatedIds?: readonly string[] | undefined;
  readonly severity: "info" | "warning";
}

export interface RoutedGraphEdge {
  readonly diagnostics: readonly RouteDiagnostic[];
  readonly fallback: boolean;
  readonly id: string;
  readonly length: number;
  readonly metrics: RouteMetrics;
  readonly path: string;
  readonly points: readonly GraphPoint[];
  readonly sourcePort: ResolvedPort;
  readonly targetPort: ResolvedPort;
}

export interface FlowGraphResult {
  readonly diagnostics: readonly RouteDiagnostic[];
  readonly metrics: FlowGraphMetrics;
  readonly routes: readonly RoutedGraphEdge[];
}
