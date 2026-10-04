import { FlowGraphError } from "./errors.js";
import {
  compactOrthogonalPoints,
  expandRect,
  type GraphSegment,
  parallelProximity,
  pointInsideRect,
  rectBottom,
  rectRight,
  routeLength,
  segmentIntersectsRectInterior,
  segmentRelation,
  serializePoints,
  toSegments,
} from "./geometry.js";
import { toRoundedSvgPath } from "./svg-path.js";
import type {
  FlowGraphInput,
  FlowGraphMetrics,
  FlowGraphResult,
  GraphNode,
  GraphObstacle,
  GraphPoint,
  GraphRect,
  OrthogonalRouterOptions,
  PortMode,
  PortSide,
  ResolvedPort,
  RouteDiagnostic,
  RoutedGraphEdge,
  RouteMetrics,
} from "./types.js";

const PORT_SIDES = ["top", "right", "bottom", "left"] as const;
const MAX_PORT_PAIRS = PORT_SIDES.length ** 2;
const DEFAULT_OPTIONS = Object.freeze({
  bendPenalty: 24,
  clearance: 8,
  crossingPenalty: 16,
  maxCoordinatesPerAxis: 192,
  maxEdges: 1_000,
  maxNodes: 500,
  maxOptimizationPasses: 8,
  overlapPenalty: 220,
  parallelGap: 16,
  portDeviationPenalty: 24,
  portStubLength: 8,
  proximityPenalty: 40,
  roundingRadius: 7,
});

interface RouterConfiguration {
  readonly bendPenalty: number;
  readonly clearance: number;
  readonly crossingPenalty: number;
  readonly maxCoordinatesPerAxis: number;
  readonly maxEdges: number;
  readonly maxNodes: number;
  readonly maxOptimizationPasses: number;
  readonly overlapPenalty: number;
  readonly parallelGap: number;
  readonly portDeviationPenalty: number;
  readonly portStubLength: number;
  readonly proximityPenalty: number;
  readonly roundingRadius: number;
}

interface NormalizedPortConstraint {
  readonly mode: PortMode;
  readonly side?: PortSide | undefined;
  readonly slot?: number | undefined;
}

interface NormalizedEndpoint {
  readonly nodeId: string;
  readonly port?: NormalizedPortConstraint | undefined;
}

interface NormalizedEdge {
  readonly id: string;
  readonly routeBounds?: GraphRect | undefined;
  readonly source: NormalizedEndpoint;
  readonly target: NormalizedEndpoint;
}

interface NormalizedGraph {
  readonly edges: readonly NormalizedEdge[];
  readonly frame: GraphRect;
  readonly nodes: readonly GraphNode[];
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly obstacles: readonly InternalObstacle[];
}

interface InternalObstacle {
  readonly bounds: GraphRect;
  readonly id: string;
  readonly nodeId?: string | undefined;
}

interface EdgePortSlots {
  readonly source: number;
  readonly target: number;
}

interface PreferredPorts {
  readonly sourceSide: PortSide;
  readonly sourceSlot: number;
  readonly targetSide: PortSide;
  readonly targetSlot: number;
}

interface PortPair {
  readonly source: ResolvedPort;
  readonly target: ResolvedPort;
}

interface InternalRoute {
  readonly edge: NormalizedEdge;
  readonly fallback: boolean;
  readonly points: readonly GraphPoint[];
  readonly portDeviation: number;
  readonly sourcePort: ResolvedPort;
  readonly targetPort: ResolvedPort;
}

interface CandidateRoute extends InternalRoute {
  readonly serialized: string;
}

interface EvaluatedRoutes {
  readonly byEdgeId: ReadonlyMap<string, RouteMetrics>;
  readonly metrics: FlowGraphMetrics;
  readonly quality: readonly (number | string)[];
}

interface VisibilityGraph {
  readonly adjacency: readonly (readonly VisibilityLink[])[];
  readonly pointIndexes: ReadonlyMap<string, number>;
  readonly points: readonly GraphPoint[];
}

interface VisibilityLink {
  readonly cost: number;
  readonly index: number;
  readonly segment: GraphSegment;
}

interface QueueItem {
  readonly cost: number;
  readonly state: number;
}

export class OrthogonalRouter {
  private readonly options: RouterConfiguration;

  public constructor(options: OrthogonalRouterOptions = {}) {
    this.options = normalizeOptions(options);
  }

  public route(input: FlowGraphInput): FlowGraphResult {
    const graph = normalizeGraph(input, this.options);
    if (graph.edges.length === 0) {
      return {
        diagnostics: [],
        metrics: emptyFlowMetrics(),
        routes: [],
      };
    }

    const portSlots = collectPortSlots(graph.edges, graph.nodesById);
    const fixedPortDiagnostics = fixedPortReuseDiagnostics(graph.edges);
    const orderedEdges = orderEdgesForRouting(graph);
    const routes = new Map<string, InternalRoute>();

    for (const edge of orderedEdges) {
      routes.set(edge.id, this.routeEdge(edge, graph, portSlots, [...routes.values()]));
    }

    let optimizationPasses = 0;
    const rejected = new Set<string>();
    while (optimizationPasses < this.options.maxOptimizationPasses) {
      const evaluated = evaluateRoutes(
        [...routes.values()],
        graph,
        this.options,
        optimizationPasses,
      );
      const conflictEdge = selectConflictEdge(evaluated, rejected);
      if (conflictEdge === undefined) {
        break;
      }

      const current = routes.get(conflictEdge);
      if (current === undefined) {
        break;
      }
      const occupied = [...routes.values()].filter((route) => route.edge.id !== conflictEdge);
      const replacement = this.routeEdge(current.edge, graph, portSlots, occupied);
      const candidateRoutes = occupied.concat(replacement);
      const candidateEvaluation = evaluateRoutes(
        candidateRoutes,
        graph,
        this.options,
        optimizationPasses + 1,
      );
      optimizationPasses += 1;

      if (compareQuality(candidateEvaluation.quality, evaluated.quality) < 0) {
        routes.set(conflictEdge, replacement);
        rejected.clear();
      } else {
        rejected.add(conflictEdge);
      }
    }

    const internalRoutes = [...routes.values()].toSorted((left, right) =>
      left.edge.id.localeCompare(right.edge.id),
    );
    const evaluated = evaluateRoutes(internalRoutes, graph, this.options, optimizationPasses);
    const optimizationLimited =
      optimizationPasses >= this.options.maxOptimizationPasses &&
      hasOptimizableConflicts(evaluated.metrics);
    const routesWithMetrics = internalRoutes.map((route) => {
      const metrics = evaluated.byEdgeId.get(route.edge.id) ?? emptyRouteMetrics();
      const diagnostics = diagnosticsForRoute(
        route,
        metrics,
        fixedPortDiagnostics.get(route.edge.id) ?? [],
      );
      const fallback = route.fallback || metrics.collisions > 0;
      return {
        diagnostics,
        fallback,
        id: route.edge.id,
        length: metrics.length,
        metrics,
        path: toRoundedSvgPath(route.points, this.options.roundingRadius),
        points: route.points,
        sourcePort: route.sourcePort,
        targetPort: route.targetPort,
      } satisfies RoutedGraphEdge;
    });
    const diagnostics = routesWithMetrics
      .flatMap((route) => route.diagnostics)
      .concat(
        optimizationLimited
          ? [
              {
                code: "ROUTE_OPTIMIZATION_LIMIT" as const,
                message: `Flow graph optimization stopped after ${optimizationPasses} passes.`,
                severity: "info" as const,
              },
            ]
          : [],
      )
      .toSorted(compareDiagnostics);

    return {
      diagnostics,
      metrics: evaluated.metrics,
      routes: routesWithMetrics,
    };
  }

  private routeEdge(
    edge: NormalizedEdge,
    graph: NormalizedGraph,
    slots: ReadonlyMap<string, EdgePortSlots>,
    occupied: readonly InternalRoute[],
  ): InternalRoute {
    const sourceNode = requireNode(graph.nodesById, edge.source.nodeId);
    const targetNode = requireNode(graph.nodesById, edge.target.nodeId);
    const preferred = preferredPorts(
      edge,
      sourceNode,
      targetNode,
      slots.get(edge.id) ?? { source: 0.5, target: 0.5 },
    );
    const routeBounds = edge.routeBounds ?? graph.frame;
    const portPairs = portPairsForEdge(
      edge,
      sourceNode,
      targetNode,
      preferred,
      this.options.portStubLength,
    );
    const boundedPortPairs = portPairs.filter(
      (pair) =>
        pointInClosedRect(pair.source.exit, routeBounds) &&
        pointInClosedRect(pair.target.exit, routeBounds),
    );
    const candidates: CandidateRoute[] = portPairs.flatMap((pair) => {
      const points = directFacingPortPath(pair, routeBounds);
      return points === undefined
        ? []
        : [
            {
              edge,
              fallback: false,
              points,
              portDeviation: portDeviation(pair, preferred),
              serialized: serializePoints(points),
              sourcePort: pair.source,
              targetPort: pair.target,
            },
          ];
    });
    const strictVisibilityGraph = buildVisibilityGraph(
      boundedPortPairs.flatMap((pair) => [pair.source.exit, pair.target.exit]),
      routeBounds,
      graph.obstacles,
      occupied,
      edge,
      this.options,
      true,
    );
    candidates.push(
      ...routeCandidatesForPortPairs(
        boundedPortPairs,
        strictVisibilityGraph,
        edge,
        routeBounds,
        preferred,
        this.options,
      ),
    );

    const strictResolved = minimumCandidate(candidates, graph, occupied, this.options);
    if (strictResolved !== undefined) {
      const metrics = evaluateCandidate(strictResolved, graph, occupied, this.options);
      if (metrics.collisions === 0 && metrics.overlap === 0 && metrics.proximity === 0) {
        return strictResolved;
      }
    }

    const permissiveVisibilityGraph = buildVisibilityGraph(
      boundedPortPairs.flatMap((pair) => [pair.source.exit, pair.target.exit]),
      routeBounds,
      graph.obstacles,
      occupied,
      edge,
      this.options,
      false,
    );
    candidates.push(
      ...routeCandidatesForPortPairs(
        boundedPortPairs,
        permissiveVisibilityGraph,
        edge,
        routeBounds,
        preferred,
        this.options,
      ),
    );
    const resolved = minimumCandidate(candidates, graph, occupied, this.options);
    if (resolved !== undefined) {
      return resolved;
    }
    const fallbackCandidates = boundedPortPairs.flatMap((pair) =>
      fallbackPaths(pair, routeBounds, this.options.parallelGap).map((points) => ({
        edge,
        fallback: true,
        points,
        portDeviation: portDeviation(pair, preferred),
        serialized: serializePoints(points),
        sourcePort: pair.source,
        targetPort: pair.target,
      })),
    );
    const fallback = minimumCandidate(fallbackCandidates, graph, occupied, this.options);
    if (fallback !== undefined) {
      return fallback;
    }

    throw new FlowGraphError(
      "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
      `Edge "${edge.id}" has no valid port inside its route bounds.`,
      {
        details: { edgeId: edge.id },
        path: `edges.${edge.id}.routeBounds`,
      },
    );
  }
}

function normalizeOptions(options: OrthogonalRouterOptions): RouterConfiguration {
  const clearance = positiveNumber(options.clearance, DEFAULT_OPTIONS.clearance, "clearance");
  return {
    bendPenalty: nonNegativeNumber(options.bendPenalty, DEFAULT_OPTIONS.bendPenalty, "bendPenalty"),
    clearance,
    crossingPenalty: nonNegativeNumber(
      options.crossingPenalty,
      DEFAULT_OPTIONS.crossingPenalty,
      "crossingPenalty",
    ),
    maxCoordinatesPerAxis: positiveInteger(
      options.maxCoordinatesPerAxis,
      DEFAULT_OPTIONS.maxCoordinatesPerAxis,
      "maxCoordinatesPerAxis",
    ),
    maxEdges: positiveInteger(options.maxEdges, DEFAULT_OPTIONS.maxEdges, "maxEdges"),
    maxNodes: positiveInteger(options.maxNodes, DEFAULT_OPTIONS.maxNodes, "maxNodes"),
    maxOptimizationPasses: nonNegativeInteger(
      options.maxOptimizationPasses,
      DEFAULT_OPTIONS.maxOptimizationPasses,
      "maxOptimizationPasses",
    ),
    overlapPenalty: nonNegativeNumber(
      options.overlapPenalty,
      DEFAULT_OPTIONS.overlapPenalty,
      "overlapPenalty",
    ),
    parallelGap: positiveNumber(options.parallelGap, DEFAULT_OPTIONS.parallelGap, "parallelGap"),
    portDeviationPenalty: nonNegativeNumber(
      options.portDeviationPenalty,
      DEFAULT_OPTIONS.portDeviationPenalty,
      "portDeviationPenalty",
    ),
    portStubLength: positiveNumber(
      options.portStubLength,
      options.clearance === undefined ? DEFAULT_OPTIONS.portStubLength : clearance,
      "portStubLength",
    ),
    proximityPenalty: nonNegativeNumber(
      options.proximityPenalty,
      DEFAULT_OPTIONS.proximityPenalty,
      "proximityPenalty",
    ),
    roundingRadius: nonNegativeNumber(
      options.roundingRadius,
      DEFAULT_OPTIONS.roundingRadius,
      "roundingRadius",
    ),
  };
}

function normalizeGraph(input: FlowGraphInput, options: RouterConfiguration): NormalizedGraph {
  const record = requireRecord(input, "Flow graph input", "");
  const rawNodes = requireArray(record.nodes, "Flow graph nodes", "nodes");
  const rawEdges = requireArray(record.edges, "Flow graph edges", "edges");
  const rawObstacles =
    record.obstacles === undefined
      ? []
      : requireArray(record.obstacles, "Flow graph obstacles", "obstacles");

  if (rawNodes.length > options.maxNodes) {
    invalidInput(`Flow graph exceeds the ${options.maxNodes} node limit.`, "nodes");
  }
  if (rawEdges.length > options.maxEdges) {
    invalidInput(`Flow graph exceeds the ${options.maxEdges} edge limit.`, "edges");
  }

  const nodes = rawNodes
    .map((value, index) => normalizeNode(value, index))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const nodeIds = uniqueIds(nodes, "node", "nodes");
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const obstacles = rawObstacles
    .map((value, index) => normalizeObstacle(value, index))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  uniqueIds(obstacles, "obstacle", "obstacles");
  const edges = rawEdges
    .map((value, index) => normalizeEdge(value, index, nodeIds, nodesById))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  uniqueIds(edges, "edge", "edges");

  const internalObstacles: InternalObstacle[] = [
    ...nodes.map((node) => ({
      bounds: expandRect(node.bounds, options.clearance),
      id: `node:${node.id}`,
      nodeId: node.id,
    })),
    ...obstacles.map((obstacle) => ({
      bounds: expandRect(obstacle.bounds, obstacle.padding ?? options.clearance),
      id: `obstacle:${obstacle.id}`,
    })),
  ];
  const frame = graphFrame(nodes, obstacles, edges, options);

  return {
    edges,
    frame,
    nodes,
    nodesById,
    obstacles: internalObstacles,
  };
}

function normalizeNode(value: unknown, index: number): GraphNode {
  const path = `nodes[${index}]`;
  const record = requireRecord(value, "Flow graph node", path);
  return {
    bounds: normalizeRect(record.bounds, `${path}.bounds`, "FLOW_GRAPH_INVALID_BOUNDS"),
    id: requireId(record.id, `${path}.id`),
  };
}

function normalizeObstacle(value: unknown, index: number): GraphObstacle {
  const path = `obstacles[${index}]`;
  const record = requireRecord(value, "Flow graph obstacle", path);
  const padding =
    record.padding === undefined
      ? undefined
      : requireNonNegativeFinite(record.padding, `${path}.padding`);
  return {
    bounds: normalizeRect(record.bounds, `${path}.bounds`, "FLOW_GRAPH_INVALID_BOUNDS"),
    id: requireId(record.id, `${path}.id`),
    ...(padding !== undefined ? { padding } : {}),
  };
}

function normalizeEdge(
  value: unknown,
  index: number,
  nodeIds: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, GraphNode>,
): NormalizedEdge {
  const path = `edges[${index}]`;
  const record = requireRecord(value, "Flow graph edge", path);
  const id = requireId(record.id, `${path}.id`);
  const source = normalizeEndpoint(record.source, `${path}.source`, nodeIds);
  const target = normalizeEndpoint(record.target, `${path}.target`, nodeIds);
  const routeBounds =
    record.routeBounds === undefined
      ? undefined
      : normalizeRect(record.routeBounds, `${path}.routeBounds`, "FLOW_GRAPH_INVALID_ROUTE_BOUNDS");

  if (routeBounds !== undefined) {
    const sourceNode = requireNode(nodesById, source.nodeId);
    const targetNode = requireNode(nodesById, target.nodeId);
    if (
      !rectContainsRect(routeBounds, sourceNode.bounds) ||
      !rectContainsRect(routeBounds, targetNode.bounds)
    ) {
      throw new FlowGraphError(
        "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
        `Edge "${id}" route bounds must contain both endpoint nodes.`,
        {
          details: { edgeId: id },
          path: `${path}.routeBounds`,
        },
      );
    }
  }

  return {
    id,
    ...(routeBounds !== undefined ? { routeBounds } : {}),
    source,
    target,
  };
}

function normalizeEndpoint(
  value: unknown,
  path: string,
  nodeIds: ReadonlySet<string>,
): NormalizedEndpoint {
  const record = requireRecord(value, "Flow graph endpoint", path);
  const nodeId = requireId(record.nodeId, `${path}.nodeId`);
  if (!nodeIds.has(nodeId)) {
    throw new FlowGraphError(
      "FLOW_GRAPH_UNKNOWN_ENDPOINT",
      `Flow graph edge references unknown node "${nodeId}".`,
      {
        details: { nodeId },
        path: `${path}.nodeId`,
      },
    );
  }
  const port =
    record.port === undefined ? undefined : normalizePortConstraint(record.port, `${path}.port`);
  return {
    nodeId,
    ...(port !== undefined ? { port } : {}),
  };
}

function normalizePortConstraint(value: unknown, path: string): NormalizedPortConstraint {
  const record = requireRecord(value, "Flow graph port", path);
  const mode =
    record.mode === undefined ? "preferred" : requirePortMode(record.mode, `${path}.mode`);
  const side = record.side === undefined ? undefined : requirePortSide(record.side, `${path}.side`);
  const slot = record.slot === undefined ? undefined : requireSlot(record.slot, `${path}.slot`);
  if (mode === "fixed" && side === undefined) {
    throw new FlowGraphError(
      "FLOW_GRAPH_INVALID_PORT",
      "A fixed flow graph port must define its side.",
      { path: `${path}.side` },
    );
  }
  return {
    mode,
    ...(side !== undefined ? { side } : {}),
    ...(slot !== undefined ? { slot } : {}),
  };
}

function collectPortSlots(
  edges: readonly NormalizedEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
): ReadonlyMap<string, EdgePortSlots> {
  const outgoing = new Map<string, NormalizedEdge[]>();
  const incoming = new Map<string, NormalizedEdge[]>();
  for (const edge of edges) {
    appendGrouped(outgoing, edge.source.nodeId, edge);
    appendGrouped(incoming, edge.target.nodeId, edge);
  }

  const slots = new Map<string, { source?: number; target?: number }>();
  for (const atomEdges of outgoing.values()) {
    const ordered = orderIncidentEdges(atomEdges, "target", nodesById);
    for (const [index, edge] of ordered.entries()) {
      slots.set(edge.id, {
        ...slots.get(edge.id),
        source: distributedSlot(index, ordered.length),
      });
    }
  }
  for (const atomEdges of incoming.values()) {
    const ordered = orderIncidentEdges(atomEdges, "source", nodesById);
    for (const [index, edge] of ordered.entries()) {
      slots.set(edge.id, {
        ...slots.get(edge.id),
        target: distributedSlot(index, ordered.length),
      });
    }
  }

  return new Map(
    [...slots].map(([id, slot]) => [
      id,
      {
        source: slot.source ?? 0.5,
        target: slot.target ?? 0.5,
      },
    ]),
  );
}

function preferredPorts(
  edge: NormalizedEdge,
  source: GraphNode,
  target: GraphNode,
  slots: EdgePortSlots,
): PreferredPorts {
  const sourceCenter = rectCenter(source.bounds);
  const targetCenter = rectCenter(target.bounds);
  if (source.id === target.id) {
    return {
      sourceSide: edge.source.port?.side ?? "right",
      sourceSlot: edge.source.port?.slot ?? 0.35,
      targetSide: edge.target.port?.side ?? "bottom",
      targetSlot: edge.target.port?.slot ?? 0.65,
    };
  }

  const deltaX = targetCenter.x - sourceCenter.x;
  const deltaY = targetCenter.y - sourceCenter.y;
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  return {
    sourceSide:
      edge.source.port?.side ??
      (horizontal ? (deltaX >= 0 ? "right" : "left") : deltaY >= 0 ? "bottom" : "top"),
    sourceSlot: edge.source.port?.slot ?? slots.source,
    targetSide:
      edge.target.port?.side ??
      (horizontal ? (deltaX >= 0 ? "left" : "right") : deltaY >= 0 ? "top" : "bottom"),
    targetSlot: edge.target.port?.slot ?? slots.target,
  };
}

function portPairsForEdge(
  edge: NormalizedEdge,
  source: GraphNode,
  target: GraphNode,
  preferred: PreferredPorts,
  clearance: number,
): readonly PortPair[] {
  const sourceSides = candidateSides(edge.source.port, preferred.sourceSide);
  const targetSides = candidateSides(edge.target.port, preferred.targetSide);
  const sourceSlot = edge.source.port?.slot ?? preferred.sourceSlot;
  const targetSlot = edge.target.port?.slot ?? preferred.targetSlot;
  const pairs = sourceSides.flatMap((sourceSide) =>
    targetSides.map((targetSide) => ({
      source: resolvePort(source.bounds, sourceSide, sourceSlot, clearance),
      target: resolvePort(target.bounds, targetSide, targetSlot, clearance),
    })),
  );
  return pairs
    .toSorted(
      (left, right) =>
        portPairDeviation(left, preferred) - portPairDeviation(right, preferred) ||
        serializePortPair(left).localeCompare(serializePortPair(right)),
    )
    .slice(0, MAX_PORT_PAIRS);
}

function candidateSides(
  constraint: NormalizedPortConstraint | undefined,
  preferred: PortSide,
): readonly PortSide[] {
  if (constraint?.mode === "fixed" && constraint.side !== undefined) {
    return [constraint.side];
  }
  const first = constraint?.side ?? preferred;
  return [first, ...PORT_SIDES.filter((side) => side !== first)];
}

function resolvePort(
  bounds: GraphRect,
  side: PortSide,
  slot: number,
  clearance: number,
): ResolvedPort {
  switch (side) {
    case "left": {
      const point = { x: bounds.x, y: bounds.y + bounds.height * slot };
      return { exit: { x: point.x - clearance, y: point.y }, point, side, slot };
    }
    case "right": {
      const point = { x: rectRight(bounds), y: bounds.y + bounds.height * slot };
      return { exit: { x: point.x + clearance, y: point.y }, point, side, slot };
    }
    case "top": {
      const point = { x: bounds.x + bounds.width * slot, y: bounds.y };
      return { exit: { x: point.x, y: point.y - clearance }, point, side, slot };
    }
    case "bottom": {
      const point = { x: bounds.x + bounds.width * slot, y: rectBottom(bounds) };
      return { exit: { x: point.x, y: point.y + clearance }, point, side, slot };
    }
  }
}

function directFacingPortPath(
  pair: PortPair,
  routeBounds: GraphRect,
): readonly GraphPoint[] | undefined {
  const source = pair.source;
  const target = pair.target;
  const horizontal =
    source.point.y === target.point.y &&
    ((source.side === "right" && target.side === "left" && source.point.x < target.point.x) ||
      (source.side === "left" && target.side === "right" && source.point.x > target.point.x));
  const vertical =
    source.point.x === target.point.x &&
    ((source.side === "bottom" && target.side === "top" && source.point.y < target.point.y) ||
      (source.side === "top" && target.side === "bottom" && source.point.y > target.point.y));

  return (horizontal || vertical) &&
    pointInClosedRect(source.point, routeBounds) &&
    pointInClosedRect(target.point, routeBounds) &&
    routeUsesOutwardPortStubs([source.point, target.point], pair)
    ? [source.point, target.point]
    : undefined;
}

function routeUsesOutwardPortStubs(points: readonly GraphPoint[], pair: PortPair): boolean {
  const afterSource = points[1];
  const beforeTarget = points.at(-2);
  return (
    afterSource !== undefined &&
    beforeTarget !== undefined &&
    pointReachesPortExit(afterSource, pair.source) &&
    pointReachesPortExit(beforeTarget, pair.target)
  );
}

function pointReachesPortExit(point: GraphPoint, port: ResolvedPort): boolean {
  switch (port.side) {
    case "left":
      return point.x <= port.exit.x;
    case "right":
      return point.x >= port.exit.x;
    case "top":
      return point.y <= port.exit.y;
    case "bottom":
      return point.y >= port.exit.y;
  }
}

function segmentMovesInwardFromPort(segment: GraphSegment, port: ResolvedPort): boolean {
  switch (port.side) {
    case "left":
      return segment.from.y === segment.to.y && segment.to.x > segment.from.x;
    case "right":
      return segment.from.y === segment.to.y && segment.to.x < segment.from.x;
    case "top":
      return segment.from.x === segment.to.x && segment.to.y > segment.from.y;
    case "bottom":
      return segment.from.x === segment.to.x && segment.to.y < segment.from.y;
  }
}

function routeCandidatesForPortPairs(
  pairs: readonly PortPair[],
  visibilityGraph: VisibilityGraph | undefined,
  edge: NormalizedEdge,
  routeBounds: GraphRect,
  preferred: PreferredPorts,
  options: RouterConfiguration,
): readonly CandidateRoute[] {
  const candidates: CandidateRoute[] = [];
  for (const pair of pairs) {
    const middle =
      edge.source.nodeId === edge.target.nodeId &&
      pointsHaveSameCoordinates(pair.source.exit, pair.target.exit)
        ? selfLoopPath(pair.source.exit, routeBounds, options.parallelGap)
        : shortestPathBetween(
            visibilityGraph,
            pair.source.exit,
            pair.target.exit,
            options,
            pair.source,
            pair.target,
          );
    if (middle === undefined) {
      continue;
    }
    const points = compactOrthogonalPoints([
      pair.source.point,
      pair.source.exit,
      ...middle,
      pair.target.exit,
      pair.target.point,
    ]);
    if (points.length < 2 || !routeUsesOutwardPortStubs(points, pair)) {
      continue;
    }
    candidates.push({
      edge,
      fallback: false,
      points,
      portDeviation: portDeviation(pair, preferred),
      serialized: serializePoints(points),
      sourcePort: pair.source,
      targetPort: pair.target,
    });
  }
  return candidates;
}

function buildVisibilityGraph(
  requiredPoints: readonly GraphPoint[],
  bounds: GraphRect,
  obstacles: readonly InternalObstacle[],
  occupied: readonly InternalRoute[],
  edge: NormalizedEdge,
  options: RouterConfiguration,
  forbidRouteConflicts: boolean,
): VisibilityGraph | undefined {
  if (requiredPoints.length === 0) {
    return undefined;
  }
  const relevantObstacles = obstacles.filter((obstacle) => rectsOverlap(obstacle.bounds, bounds));
  const xValues = new Set<number>([
    bounds.x,
    rectRight(bounds),
    ...requiredPoints.map((point) => point.x),
  ]);
  const yValues = new Set<number>([
    bounds.y,
    rectBottom(bounds),
    ...requiredPoints.map((point) => point.y),
  ]);
  for (const obstacle of relevantObstacles) {
    appendObstacleCoordinates(
      xValues,
      obstacle.bounds.x,
      rectRight(obstacle.bounds),
      options.parallelGap,
    );
    appendObstacleCoordinates(
      yValues,
      obstacle.bounds.y,
      rectBottom(obstacle.bounds),
      options.parallelGap,
    );
  }
  for (const route of occupied) {
    for (const segment of toSegments(route.points)) {
      xValues.add(segment.from.x);
      xValues.add(segment.to.x);
      yValues.add(segment.from.y);
      yValues.add(segment.to.y);
      if (segment.from.y === segment.to.y) {
        yValues.add(segment.from.y - options.parallelGap);
        yValues.add(segment.from.y + options.parallelGap);
      } else {
        xValues.add(segment.from.x - options.parallelGap);
        xValues.add(segment.from.x + options.parallelGap);
      }
    }
  }

  const xs = boundedCoordinates(
    xValues,
    bounds.x,
    rectRight(bounds),
    new Set([bounds.x, rectRight(bounds), ...requiredPoints.map((point) => point.x)]),
    options.maxCoordinatesPerAxis,
  );
  const ys = boundedCoordinates(
    yValues,
    bounds.y,
    rectBottom(bounds),
    new Set([bounds.y, rectBottom(bounds), ...requiredPoints.map((point) => point.y)]),
    options.maxCoordinatesPerAxis,
  );
  const points: GraphPoint[] = [];
  const pointIndexes = new Map<string, number>();
  const rowIndexes = new Map<number, number[]>();
  const columnIndexes = new Map<number, number[]>();

  for (const y of ys) {
    for (const x of xs) {
      const point = { x, y };
      if (relevantObstacles.some((obstacle) => pointInsideRect(point, obstacle.bounds))) {
        continue;
      }
      const index = points.length;
      points.push(point);
      pointIndexes.set(pointKey(point), index);
      appendGrouped(rowIndexes, y, index);
      appendGrouped(columnIndexes, x, index);
    }
  }

  const adjacency: VisibilityLink[][] = points.map(() => []);
  for (const indexes of rowIndexes.values()) {
    connectVisibleIndexes(
      indexes,
      points,
      adjacency,
      relevantObstacles,
      occupied,
      edge,
      options,
      "x",
      forbidRouteConflicts,
    );
  }
  for (const indexes of columnIndexes.values()) {
    connectVisibleIndexes(
      indexes,
      points,
      adjacency,
      relevantObstacles,
      occupied,
      edge,
      options,
      "y",
      forbidRouteConflicts,
    );
  }
  for (const links of adjacency) {
    links.sort(
      (left, right) =>
        left.index - right.index ||
        serializeSegment(left.segment).localeCompare(serializeSegment(right.segment)),
    );
  }

  return { adjacency, pointIndexes, points };
}

function shortestPathBetween(
  graph: VisibilityGraph | undefined,
  start: GraphPoint,
  end: GraphPoint,
  options: RouterConfiguration,
  sourcePort: ResolvedPort,
  targetPort: ResolvedPort,
): readonly GraphPoint[] | undefined {
  const startIndex = graph?.pointIndexes.get(pointKey(start));
  const endIndex = graph?.pointIndexes.get(pointKey(end));
  if (graph === undefined || startIndex === undefined || endIndex === undefined) {
    return undefined;
  }
  if (startIndex === endIndex) {
    const point = graph.points[startIndex];
    return point === undefined ? undefined : [point];
  }

  const directionCount = 3;
  const stateCount = graph.points.length * directionCount;
  const distances = Array<number>(stateCount).fill(Number.POSITIVE_INFINITY);
  const previous = Array<number>(stateCount).fill(-1);
  const queue = new MinQueue();
  const startState = startIndex * directionCount;
  distances[startState] = 0;
  queue.push({ cost: 0, state: startState });

  while (queue.size > 0) {
    const current = queue.pop();
    if (current === undefined || current.cost !== distances[current.state]) {
      continue;
    }
    const pointIndex = Math.floor(current.state / directionCount);
    const previousDirection = current.state % directionCount;
    const links = graph.adjacency[pointIndex] ?? [];

    for (const link of links) {
      if (
        (pointIndex === startIndex && segmentMovesInwardFromPort(link.segment, sourcePort)) ||
        (link.index === endIndex && !pointReachesPortExit(link.segment.from, targetPort))
      ) {
        continue;
      }
      const direction = link.segment.from.y === link.segment.to.y ? 1 : 2;
      const bendCost =
        previousDirection !== 0 && previousDirection !== direction ? options.bendPenalty : 0;
      const nextState = link.index * directionCount + direction;
      const cost = current.cost + link.cost + bendCost;
      const previousCost = distances[nextState] ?? Number.POSITIVE_INFINITY;
      const previousState = previous[nextState] ?? -1;
      if (cost < previousCost || (cost === previousCost && current.state < previousState)) {
        distances[nextState] = cost;
        previous[nextState] = current.state;
        queue.push({ cost, state: nextState });
      }
    }
  }

  const endStates = [endIndex * directionCount + 1, endIndex * directionCount + 2];
  const endState = endStates.toSorted(
    (left, right) =>
      (distances[left] ?? Number.POSITIVE_INFINITY) -
        (distances[right] ?? Number.POSITIVE_INFINITY) || left - right,
  )[0];
  if (endState === undefined || !Number.isFinite(distances[endState])) {
    return undefined;
  }

  const reversed: GraphPoint[] = [];
  let state = endState;
  while (state >= 0) {
    const point = graph.points[Math.floor(state / directionCount)];
    if (point !== undefined) {
      reversed.push(point);
    }
    if (state === startState) {
      break;
    }
    state = previous[state] ?? -1;
  }
  if (state !== startState) {
    return undefined;
  }
  return compactOrthogonalPoints(reversed.reverse());
}

function connectVisibleIndexes(
  input: readonly number[],
  points: readonly GraphPoint[],
  adjacency: VisibilityLink[][],
  obstacles: readonly InternalObstacle[],
  occupied: readonly InternalRoute[],
  edge: NormalizedEdge,
  options: RouterConfiguration,
  axis: "x" | "y",
  forbidRouteConflicts: boolean,
): void {
  const indexes = [...input].toSorted((left, right) => {
    const leftPoint = points[left];
    const rightPoint = points[right];
    if (leftPoint === undefined || rightPoint === undefined) {
      return left - right;
    }
    return leftPoint[axis] - rightPoint[axis] || left - right;
  });
  for (let index = 1; index < indexes.length; index += 1) {
    const fromIndex = indexes[index - 1];
    const toIndex = indexes[index];
    const from = fromIndex === undefined ? undefined : points[fromIndex];
    const to = toIndex === undefined ? undefined : points[toIndex];
    if (
      fromIndex === undefined ||
      toIndex === undefined ||
      from === undefined ||
      to === undefined
    ) {
      continue;
    }
    const segment = { from, to };
    if (
      obstacles.some((obstacle) => segmentIntersectsRectInterior(segment, obstacle.bounds)) ||
      (forbidRouteConflicts &&
        segmentConflictsWithOccupiedRoute(segment, occupied, options.parallelGap))
    ) {
      continue;
    }
    const cost = segmentLength(segment) + segmentOccupancyCost(segment, occupied, edge, options);
    const reverse = { from: to, to: from };
    adjacency[fromIndex]?.push({ cost, index: toIndex, segment });
    adjacency[toIndex]?.push({ cost, index: fromIndex, segment: reverse });
  }
}

function minimumCandidate(
  candidates: readonly CandidateRoute[],
  graph: NormalizedGraph,
  occupied: readonly InternalRoute[],
  options: RouterConfiguration,
): CandidateRoute | undefined {
  return candidates.toSorted((left, right) => {
    const leftMetrics = evaluateCandidate(left, graph, occupied, options);
    const rightMetrics = evaluateCandidate(right, graph, occupied, options);
    return compareQuality(
      candidateQuality(left, leftMetrics, options),
      candidateQuality(right, rightMetrics, options),
    );
  })[0];
}

function evaluateCandidate(
  route: InternalRoute,
  graph: NormalizedGraph,
  occupied: readonly InternalRoute[],
  options: RouterConfiguration,
): RouteMetrics {
  const metrics = baseRouteMetrics(route, graph);
  let crossings = 0;
  let overlap = 0;
  let proximity = 0;
  for (const other of occupied) {
    const relation = routeRelations(route, other, options.parallelGap);
    crossings += relation.crossings;
    overlap += relation.overlap;
    proximity += relation.proximity;
  }
  return { ...metrics, crossings, overlap, proximity };
}

function evaluateRoutes(
  routes: readonly InternalRoute[],
  graph: NormalizedGraph,
  options: RouterConfiguration,
  optimizationPasses: number,
): EvaluatedRoutes {
  const mutable = new Map<string, RouteMetrics>();
  for (const route of routes) {
    mutable.set(route.edge.id, baseRouteMetrics(route, graph));
  }

  let crossingPairs = 0;
  let overlapPairs = 0;
  let proximityPairs = 0;
  for (const [leftIndex, left] of routes.entries()) {
    for (const right of routes.slice(leftIndex + 1)) {
      const relation = routeRelations(left, right, options.parallelGap);
      crossingPairs += relation.crossings;
      overlapPairs += relation.overlap;
      proximityPairs += relation.proximity;
      mutable.set(left.edge.id, addRouteRelations(mutable.get(left.edge.id), relation));
      mutable.set(right.edge.id, addRouteRelations(mutable.get(right.edge.id), relation));
    }
  }

  const routeMetrics = [...mutable.values()];
  const collisions = sum(routeMetrics.map((metrics) => metrics.collisions));
  const fallbackCount = routes.filter(
    (route) => route.fallback || (mutable.get(route.edge.id)?.collisions ?? 0) > 0,
  ).length;
  const portDeviation = sum(routeMetrics.map((metrics) => metrics.portDeviation));
  const bends = sum(routeMetrics.map((metrics) => metrics.bends));
  const length = sum(routeMetrics.map((metrics) => metrics.length));
  const serialized = routes
    .toSorted((left, right) => left.edge.id.localeCompare(right.edge.id))
    .map((route) => `${route.edge.id}:${serializePoints(route.points)}`)
    .join("|");
  const metrics: FlowGraphMetrics = {
    bends,
    collisions,
    crossings: crossingPairs,
    fallbackCount,
    length,
    optimizationPasses,
    overlap: overlapPairs,
    portDeviation,
    proximity: proximityPairs,
    routeCount: routes.length,
  };
  return {
    byEdgeId: mutable,
    metrics,
    quality: [
      collisions,
      overlapPairs,
      fallbackCount,
      proximityPairs,
      crossingPairs,
      routeSelectionCost({ bends, length, portDeviation }, options),
      bends,
      length,
      portDeviation,
      serialized,
    ],
  };
}

function baseRouteMetrics(route: InternalRoute, graph: NormalizedGraph): RouteMetrics {
  return {
    bends: Math.max(0, route.points.length - 2),
    collisions: collisionCount(route, graph.obstacles),
    crossings: 0,
    length: routeLength(route.points),
    overlap: 0,
    portDeviation: route.portDeviation,
    proximity: 0,
  };
}

function collisionCount(route: InternalRoute, obstacles: readonly InternalObstacle[]): number {
  const segments = toSegments(route.points);
  return obstacles.filter((obstacle) =>
    segments.some((segment, index) => {
      const controlledSource = obstacle.nodeId === route.edge.source.nodeId && index === 0;
      const controlledTarget =
        obstacle.nodeId === route.edge.target.nodeId && index === segments.length - 1;
      return (
        !controlledSource &&
        !controlledTarget &&
        segmentIntersectsRectInterior(segment, obstacle.bounds)
      );
    }),
  ).length;
}

function routeRelations(
  left: InternalRoute,
  right: InternalRoute,
  parallelGap: number,
): { readonly crossings: number; readonly overlap: number; readonly proximity: number } {
  let crossings = 0;
  let overlap = 0;
  let proximity = 0;
  const sharedEndpoint = routesShareEndpoint(left.edge, right.edge);
  for (const leftSegment of toSegments(left.points)) {
    for (const rightSegment of toSegments(right.points)) {
      const relation = segmentRelation(leftSegment, rightSegment);
      if (!sharedEndpoint && relation.crosses) {
        crossings += 1;
      }
      overlap += relation.overlap;
      proximity += parallelProximity(leftSegment, rightSegment, parallelGap);
    }
  }
  return { crossings, overlap, proximity };
}

function segmentOccupancyCost(
  segment: GraphSegment,
  occupied: readonly InternalRoute[],
  edge: NormalizedEdge,
  options: RouterConfiguration,
): number {
  let cost = 0;
  for (const route of occupied) {
    const sharedEndpoint = routesShareEndpoint(edge, route.edge);
    for (const previous of toSegments(route.points)) {
      const relation = segmentRelation(segment, previous);
      cost += relation.overlap * options.overlapPenalty;
      cost += parallelProximity(segment, previous, options.parallelGap) * options.proximityPenalty;
      if (!sharedEndpoint && relation.crosses) {
        cost += options.crossingPenalty;
      }
    }
  }
  return cost;
}

function segmentConflictsWithOccupiedRoute(
  segment: GraphSegment,
  occupied: readonly InternalRoute[],
  parallelGap: number,
): boolean {
  return occupied.some((route) =>
    toSegments(route.points).some(
      (previous) =>
        segmentRelation(segment, previous).overlap > 0 ||
        parallelProximity(segment, previous, parallelGap) > 0,
    ),
  );
}

function candidateQuality(
  route: CandidateRoute,
  metrics: RouteMetrics,
  options: RouterConfiguration,
): readonly (number | string)[] {
  return [
    metrics.collisions,
    metrics.overlap,
    route.fallback ? 1 : 0,
    metrics.proximity,
    metrics.crossings,
    routeSelectionCost(metrics, options),
    metrics.bends,
    metrics.length,
    metrics.portDeviation,
    route.serialized,
  ];
}

function routeSelectionCost(
  metrics: Pick<RouteMetrics, "bends" | "length" | "portDeviation">,
  options: RouterConfiguration,
): number {
  return (
    metrics.length +
    metrics.bends * options.bendPenalty +
    metrics.portDeviation * options.portDeviationPenalty
  );
}

function selectConflictEdge(
  evaluated: EvaluatedRoutes,
  rejected: ReadonlySet<string>,
): string | undefined {
  return [...evaluated.byEdgeId]
    .filter(
      ([edgeId, metrics]) =>
        !rejected.has(edgeId) &&
        (metrics.collisions > 0 ||
          metrics.overlap > 0 ||
          metrics.proximity > 0 ||
          metrics.crossings > 0),
    )
    .toSorted(
      ([leftId, left], [rightId, right]) =>
        right.collisions - left.collisions ||
        right.overlap - left.overlap ||
        right.proximity - left.proximity ||
        right.crossings - left.crossings ||
        right.bends - left.bends ||
        right.length - left.length ||
        leftId.localeCompare(rightId),
    )[0]?.[0];
}

function diagnosticsForRoute(
  route: InternalRoute,
  metrics: RouteMetrics,
  fixedPortDiagnostics: readonly RouteDiagnostic[],
): readonly RouteDiagnostic[] {
  const diagnostics = [...fixedPortDiagnostics];
  if (route.fallback || metrics.collisions > 0) {
    diagnostics.push({
      code: "ROUTE_COLLISION_FALLBACK",
      edgeId: route.edge.id,
      message: `Edge "${route.edge.id}" uses a fallback route with ${metrics.collisions} obstacle collisions.`,
      severity: "warning",
    });
  }
  if (metrics.overlap > 0) {
    diagnostics.push({
      code: "ROUTE_OVERLAP_REMAINS",
      edgeId: route.edge.id,
      message: `Edge "${route.edge.id}" retains ${formatMetric(metrics.overlap)} units of shared routing.`,
      severity: "warning",
    });
  }
  if (metrics.proximity > 0) {
    diagnostics.push({
      code: "ROUTE_PROXIMITY_REMAINS",
      edgeId: route.edge.id,
      message: `Edge "${route.edge.id}" retains close parallel routing.`,
      severity: "info",
    });
  }
  if (metrics.crossings > 0) {
    diagnostics.push({
      code: "ROUTE_CROSSING_REMAINS",
      edgeId: route.edge.id,
      message: `Edge "${route.edge.id}" retains ${metrics.crossings} crossings.`,
      severity: "info",
    });
  }
  return diagnostics.toSorted(compareDiagnostics);
}

function fixedPortReuseDiagnostics(
  edges: readonly NormalizedEdge[],
): ReadonlyMap<string, readonly RouteDiagnostic[]> {
  const grouped = new Map<string, string[]>();
  for (const edge of edges) {
    appendFixedPort(grouped, edge.id, edge.source);
    appendFixedPort(grouped, edge.id, edge.target);
  }
  const diagnostics = new Map<string, RouteDiagnostic[]>();
  for (const edgeIds of grouped.values()) {
    const unique = [...new Set(edgeIds)].toSorted();
    if (unique.length < 2) {
      continue;
    }
    for (const edgeId of unique) {
      appendGrouped(diagnostics, edgeId, {
        code: "ROUTE_PORT_REUSED_BY_CONSTRAINT",
        edgeId,
        message: `Edge "${edgeId}" reuses a fixed port with another edge.`,
        relatedIds: unique.filter((candidate) => candidate !== edgeId),
        severity: "warning",
      });
    }
  }
  return diagnostics;
}

function appendFixedPort(
  grouped: Map<string, string[]>,
  edgeId: string,
  endpoint: NormalizedEndpoint,
): void {
  const port = endpoint.port;
  if (port?.mode !== "fixed" || port.side === undefined || port.slot === undefined) {
    return;
  }
  appendGrouped(grouped, `${endpoint.nodeId}:${port.side}:${port.slot}`, edgeId);
}

function fallbackPaths(
  pair: PortPair,
  bounds: GraphRect,
  gap: number,
): readonly (readonly GraphPoint[])[] {
  const source = pair.source;
  const target = pair.target;
  const top = bounds.y + Math.min(gap, bounds.height / 4);
  const bottom = rectBottom(bounds) - Math.min(gap, bounds.height / 4);
  const left = bounds.x + Math.min(gap, bounds.width / 4);
  const right = rectRight(bounds) - Math.min(gap, bounds.width / 4);
  const paths = [
    [source.point, source.exit, { x: target.exit.x, y: source.exit.y }, target.exit, target.point],
    [source.point, source.exit, { x: source.exit.x, y: target.exit.y }, target.exit, target.point],
    [
      source.point,
      source.exit,
      { x: source.exit.x, y: top },
      { x: target.exit.x, y: top },
      target.exit,
      target.point,
    ],
    [
      source.point,
      source.exit,
      { x: right, y: source.exit.y },
      { x: right, y: target.exit.y },
      target.exit,
      target.point,
    ],
    [
      source.point,
      source.exit,
      { x: source.exit.x, y: bottom },
      { x: target.exit.x, y: bottom },
      target.exit,
      target.point,
    ],
    [
      source.point,
      source.exit,
      { x: left, y: source.exit.y },
      { x: left, y: target.exit.y },
      target.exit,
      target.point,
    ],
  ];
  return paths
    .map(compactOrthogonalPoints)
    .filter((points) => points.length >= 2)
    .filter(
      (points, index, all) =>
        all.findIndex((candidate) => serializePoints(candidate) === serializePoints(points)) ===
        index,
    );
}

function selfLoopPath(exit: GraphPoint, bounds: GraphRect, gap: number): readonly GraphPoint[] {
  const right = Math.max(exit.x + gap, rectRight(bounds) - gap);
  const bottom = Math.max(exit.y + gap, rectBottom(bounds) - gap);
  return [exit, { x: right, y: exit.y }, { x: right, y: bottom }, { x: exit.x, y: bottom }, exit];
}

function orderEdgesForRouting(graph: NormalizedGraph): readonly NormalizedEdge[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source.nodeId, (degree.get(edge.source.nodeId) ?? 0) + 1);
    degree.set(edge.target.nodeId, (degree.get(edge.target.nodeId) ?? 0) + 1);
  }
  return [...graph.edges].toSorted((left, right) => {
    const leftFixed = fixedPortCount(left);
    const rightFixed = fixedPortCount(right);
    const leftDegree =
      (degree.get(left.source.nodeId) ?? 0) + (degree.get(left.target.nodeId) ?? 0);
    const rightDegree =
      (degree.get(right.source.nodeId) ?? 0) + (degree.get(right.target.nodeId) ?? 0);
    const leftDistance = endpointDistance(left, graph.nodesById);
    const rightDistance = endpointDistance(right, graph.nodesById);
    return (
      rightFixed - leftFixed ||
      Number(right.routeBounds !== undefined) - Number(left.routeBounds !== undefined) ||
      rightDegree - leftDegree ||
      leftDistance - rightDistance ||
      left.id.localeCompare(right.id)
    );
  });
}

function graphFrame(
  nodes: readonly GraphNode[],
  obstacles: readonly GraphObstacle[],
  edges: readonly NormalizedEdge[],
  options: RouterConfiguration,
): GraphRect {
  const rects = [
    ...nodes.map((node) => node.bounds),
    ...obstacles.map((obstacle) => obstacle.bounds),
    ...edges.flatMap((edge) => (edge.routeBounds === undefined ? [] : [edge.routeBounds])),
  ];
  if (rects.length === 0) {
    return { height: 1, width: 1, x: 0, y: 0 };
  }
  const margin = options.clearance * 4 + options.parallelGap * 2;
  const minimumX = Math.min(...rects.map((rect) => rect.x)) - margin;
  const minimumY = Math.min(...rects.map((rect) => rect.y)) - margin;
  const maximumX = Math.max(...rects.map(rectRight)) + margin;
  const maximumY = Math.max(...rects.map(rectBottom)) + margin;
  return {
    height: maximumY - minimumY,
    width: maximumX - minimumX,
    x: minimumX,
    y: minimumY,
  };
}

function appendObstacleCoordinates(
  values: Set<number>,
  start: number,
  end: number,
  gap: number,
): void {
  values.add(start - gap);
  values.add(start);
  values.add(end);
  values.add(end + gap);
}

function boundedCoordinates(
  input: ReadonlySet<number>,
  minimum: number,
  maximum: number,
  required: ReadonlySet<number>,
  limit: number,
): readonly number[] {
  const values = [...input]
    .filter((value) => Number.isFinite(value) && value >= minimum && value <= maximum)
    .toSorted((left, right) => left - right);
  const withMidpoints = [...values];
  if (values.length * 2 < limit) {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous !== undefined && current !== undefined && current > previous) {
        withMidpoints.push((previous + current) / 2);
      }
    }
  }
  const unique = [...new Set(withMidpoints)].toSorted((left, right) => left - right);
  if (unique.length <= limit) {
    return unique;
  }

  const selected = new Set([...required].filter((value) => value >= minimum && value <= maximum));
  const remaining = unique.filter((value) => !selected.has(value));
  const available = Math.max(0, limit - selected.size);
  for (let index = 0; index < available; index += 1) {
    const candidate = remaining[Math.floor((index * remaining.length) / available)];
    if (candidate !== undefined) {
      selected.add(candidate);
    }
  }
  return [...selected].toSorted((left, right) => left - right);
}

function addRouteRelations(
  current: RouteMetrics | undefined,
  relation: { readonly crossings: number; readonly overlap: number; readonly proximity: number },
): RouteMetrics {
  const metrics = current ?? emptyRouteMetrics();
  return {
    ...metrics,
    crossings: metrics.crossings + relation.crossings,
    overlap: metrics.overlap + relation.overlap,
    proximity: metrics.proximity + relation.proximity,
  };
}

function emptyRouteMetrics(): RouteMetrics {
  return {
    bends: 0,
    collisions: 0,
    crossings: 0,
    length: 0,
    overlap: 0,
    portDeviation: 0,
    proximity: 0,
  };
}

function emptyFlowMetrics(): FlowGraphMetrics {
  return {
    ...emptyRouteMetrics(),
    fallbackCount: 0,
    optimizationPasses: 0,
    routeCount: 0,
  };
}

function hasOptimizableConflicts(metrics: FlowGraphMetrics): boolean {
  return (
    metrics.collisions > 0 || metrics.overlap > 0 || metrics.proximity > 0 || metrics.crossings > 0
  );
}

function portDeviation(pair: PortPair, preferred: PreferredPorts): number {
  return (
    Number(pair.source.side !== preferred.sourceSide) +
    Number(pair.target.side !== preferred.targetSide) +
    Math.abs(pair.source.slot - preferred.sourceSlot) +
    Math.abs(pair.target.slot - preferred.targetSlot)
  );
}

function portPairDeviation(pair: PortPair, preferred: PreferredPorts): number {
  return (
    Number(pair.source.side !== preferred.sourceSide) +
    Number(pair.target.side !== preferred.targetSide)
  );
}

function serializePortPair(pair: PortPair): string {
  return `${pair.source.side}:${pair.source.slot}:${pair.target.side}:${pair.target.slot}`;
}

function compareQuality(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue;
    }
    return String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
  }
  return 0;
}

function compareDiagnostics(left: RouteDiagnostic, right: RouteDiagnostic): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    (left.edgeId ?? "").localeCompare(right.edgeId ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function severityRank(value: RouteDiagnostic["severity"]): number {
  return value === "warning" ? 1 : 0;
}

function appendGrouped<Key, Value>(grouped: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = grouped.get(key) ?? [];
  values.push(value);
  grouped.set(key, values);
}

function orderIncidentEdges(
  edges: readonly NormalizedEdge[],
  endpoint: "source" | "target",
  nodesById: ReadonlyMap<string, GraphNode>,
): readonly NormalizedEdge[] {
  return [...edges].toSorted((left, right) => {
    const leftNode = nodesById.get(left[endpoint].nodeId);
    const rightNode = nodesById.get(right[endpoint].nodeId);
    const leftCenter = leftNode === undefined ? { x: 0, y: 0 } : rectCenter(leftNode.bounds);
    const rightCenter = rightNode === undefined ? { x: 0, y: 0 } : rectCenter(rightNode.bounds);
    return (
      leftCenter.y - rightCenter.y ||
      leftCenter.x - rightCenter.x ||
      left.id.localeCompare(right.id)
    );
  });
}

function distributedSlot(index: number, count: number): number {
  return count <= 1 ? 0.5 : 0.18 + (index * 0.64) / (count - 1);
}

function fixedPortCount(edge: NormalizedEdge): number {
  return Number(edge.source.port?.mode === "fixed") + Number(edge.target.port?.mode === "fixed");
}

function endpointDistance(edge: NormalizedEdge, nodesById: ReadonlyMap<string, GraphNode>): number {
  const source = nodesById.get(edge.source.nodeId);
  const target = nodesById.get(edge.target.nodeId);
  if (source === undefined || target === undefined) {
    return 0;
  }
  const sourceCenter = rectCenter(source.bounds);
  const targetCenter = rectCenter(target.bounds);
  return Math.abs(sourceCenter.x - targetCenter.x) + Math.abs(sourceCenter.y - targetCenter.y);
}

function routesShareEndpoint(left: NormalizedEdge, right: NormalizedEdge): boolean {
  return (
    left.source.nodeId === right.source.nodeId ||
    left.source.nodeId === right.target.nodeId ||
    left.target.nodeId === right.source.nodeId ||
    left.target.nodeId === right.target.nodeId
  );
}

function pointInClosedRect(point: GraphPoint, rect: GraphRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rectRight(rect) &&
    point.y >= rect.y &&
    point.y <= rectBottom(rect)
  );
}

function rectContainsRect(container: GraphRect, child: GraphRect): boolean {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    rectRight(child) <= rectRight(container) &&
    rectBottom(child) <= rectBottom(container)
  );
}

function rectsOverlap(left: GraphRect, right: GraphRect): boolean {
  return (
    rectRight(left) >= right.x &&
    left.x <= rectRight(right) &&
    rectBottom(left) >= right.y &&
    left.y <= rectBottom(right)
  );
}

function rectCenter(rect: GraphRect): GraphPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function segmentLength(segment: GraphSegment): number {
  return Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y);
}

function serializeSegment(segment: GraphSegment): string {
  return `${pointKey(segment.from)}:${pointKey(segment.to)}`;
}

function pointKey(point: GraphPoint): string {
  return `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
}

function pointsHaveSameCoordinates(left: GraphPoint, right: GraphPoint): boolean {
  return pointKey(left) === pointKey(right);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMetric(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function uniqueIds<T extends { readonly id: string }>(
  values: readonly T[],
  kind: string,
  path: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) {
      throw new FlowGraphError(
        "FLOW_GRAPH_DUPLICATE_ID",
        `Duplicate flow graph ${kind} ID: ${value.id}.`,
        {
          details: { id: value.id, kind },
          path: `${path}[${index}].id`,
        },
      );
    }
    ids.add(value.id);
  }
  return ids;
}

function normalizeRect(
  value: unknown,
  path: string,
  code: "FLOW_GRAPH_INVALID_BOUNDS" | "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
): GraphRect {
  const record = requireRecord(value, "Flow graph bounds", path);
  const x = requireFinite(record.x, `${path}.x`, code);
  const y = requireFinite(record.y, `${path}.y`, code);
  const width = requirePositiveFinite(record.width, `${path}.width`, code);
  const height = requirePositiveFinite(record.height, `${path}.height`, code);
  return { height, width, x, y };
}

function requireRecord(
  value: unknown,
  label: string,
  path: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput(`${label} must be an object.`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, label: string, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidInput(`${label} must be an array.`, path);
  }
  return value;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput("Flow graph IDs must be non-empty strings.", path);
  }
  return value.trim();
}

function requirePortMode(value: unknown, path: string): PortMode {
  if (value !== "fixed" && value !== "preferred") {
    throw new FlowGraphError(
      "FLOW_GRAPH_INVALID_PORT",
      'Flow graph port mode must be "fixed" or "preferred".',
      { path },
    );
  }
  return value;
}

function requirePortSide(value: unknown, path: string): PortSide {
  if (!PORT_SIDES.includes(value as PortSide)) {
    throw new FlowGraphError("FLOW_GRAPH_INVALID_PORT", "Flow graph port side is invalid.", {
      path,
    });
  }
  return value as PortSide;
}

function requireSlot(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new FlowGraphError(
      "FLOW_GRAPH_INVALID_PORT",
      "Flow graph port slot must be between 0 and 1.",
      { path },
    );
  }
  return value;
}

function requireFinite(
  value: unknown,
  path: string,
  code: "FLOW_GRAPH_INVALID_BOUNDS" | "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FlowGraphError(code, "Flow graph coordinates must be finite numbers.", { path });
  }
  return value;
}

function requirePositiveFinite(
  value: unknown,
  path: string,
  code: "FLOW_GRAPH_INVALID_BOUNDS" | "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
): number {
  const number = requireFinite(value, path, code);
  if (number <= 0) {
    throw new FlowGraphError(code, "Flow graph dimensions must be greater than zero.", { path });
  }
  return number;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FlowGraphError(
      "FLOW_GRAPH_INVALID_BOUNDS",
      "Flow graph obstacle padding must be a non-negative finite number.",
      { path },
    );
  }
  return value;
}

function invalidInput(message: string, path: string): never {
  throw new FlowGraphError("FLOW_GRAPH_INVALID_INPUT", message, {
    ...(path ? { path } : {}),
  });
}

function requireNode(nodesById: ReadonlyMap<string, GraphNode>, id: string): GraphNode {
  const node = nodesById.get(id);
  if (node === undefined) {
    throw new FlowGraphError(
      "FLOW_GRAPH_UNKNOWN_ENDPOINT",
      `Flow graph edge references unknown node "${id}".`,
      { details: { nodeId: id } },
    );
  }
  return node;
}

function positiveNumber(value: number | undefined, fallback: number, path: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    invalidInput(`Orthogonal router ${path} must be a positive finite number.`, path);
  }
  return resolved;
}

function nonNegativeNumber(value: number | undefined, fallback: number, path: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    invalidInput(`Orthogonal router ${path} must be a non-negative finite number.`, path);
  }
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, path: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    invalidInput(`Orthogonal router ${path} must be a positive integer.`, path);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, path: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    invalidInput(`Orthogonal router ${path} must be a non-negative integer.`, path);
  }
  return resolved;
}

class MinQueue {
  private readonly items: QueueItem[] = [];

  public get size(): number {
    return this.items.length;
  }

  public push(item: QueueItem): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.items[parent];
      if (parentItem !== undefined && compareQueueItems(parentItem, item) <= 0) {
        break;
      }
      this.items[index] = parentItem as QueueItem;
      index = parent;
    }
    this.items[index] = item;
  }

  public pop(): QueueItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (first === undefined || last === undefined || this.items.length === 0) {
      return first;
    }

    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      const left = this.items[leftIndex];
      const right = this.items[rightIndex];
      if (left === undefined) {
        break;
      }
      const childIndex =
        right !== undefined && compareQueueItems(right, left) < 0 ? rightIndex : leftIndex;
      const child = this.items[childIndex] as QueueItem;
      if (compareQueueItems(last, child) <= 0) {
        break;
      }
      this.items[index] = child;
      index = childIndex;
    }
    this.items[index] = last;
    return first;
  }
}

function compareQueueItems(left: QueueItem, right: QueueItem): number {
  return left.cost - right.cost || left.state - right.state;
}
