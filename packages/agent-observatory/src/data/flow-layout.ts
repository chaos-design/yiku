import {
  FlowGraphError,
  type FlowGraphMetrics,
  type GraphEdge,
  type GraphPoint,
  type GraphRect,
  OrthogonalRouter,
  offsetOrthogonalRoute,
  type PortConstraint,
  type RouteDiagnostic,
  routeLength,
  toRoundedSvgPath,
} from "@yiku/flow-graph";
import {
  ATOM_NODE_HEIGHT,
  type AtomLayout,
  type DomainLayout,
  domainLayoutsForAtoms,
  type EdgeLayout,
  edgeRouteKey,
} from "./atom-layout.js";

const CANVAS_PADDING = 24;
const EDGE_ROUNDING_RADIUS = 4;
const ROUTER_OPTIONS = {
  clearance: 12,
  crossingPenalty: 960,
  maxOptimizationPasses: 32,
  parallelGap: 16,
  portStubLength: 18,
} as const;
const deepRouter = new OrthogonalRouter({
  ...ROUTER_OPTIONS,
  bendPenalty: 40,
  maxCoordinatesPerAxis: 56,
});
const runtimeRouter = new OrthogonalRouter({
  ...ROUTER_OPTIONS,
  bendPenalty: 24,
  maxCoordinatesPerAxis: 60,
});

export interface RoutedFlowEdge extends EdgeLayout {
  readonly endPoint: GraphPoint;
  readonly fallback: boolean;
  readonly key: string;
  readonly length: number;
  readonly path: string;
  readonly points: readonly (readonly GraphPoint[])[];
  readonly startPoint: GraphPoint;
}

export interface FlowLayout {
  readonly atoms: readonly AtomLayout[];
  readonly diagnostics: readonly RouteDiagnostic[];
  readonly domains: readonly DomainLayout[];
  readonly edges: readonly RoutedFlowEdge[];
  readonly height: number;
  readonly metrics: FlowGraphMetrics;
  readonly width: number;
}

export class FlowLayoutEngine {
  public async layout(
    atoms: readonly AtomLayout[],
    edges: readonly EdgeLayout[],
  ): Promise<FlowLayout> {
    if (!Array.isArray(atoms)) {
      throw new FlowGraphError("FLOW_GRAPH_INVALID_INPUT", "Flow layout atoms must be an array.", {
        path: "atoms",
      });
    }
    if (!Array.isArray(edges)) {
      throw new FlowGraphError("FLOW_GRAPH_INVALID_INPUT", "Flow layout edges must be an array.", {
        path: "edges",
      });
    }
    const domains = domainLayoutsForAtoms(atoms);
    const atomsByKey = new Map(atoms.map((atom) => [atom.key, atom]));
    const router = atoms.some((atom) => atom.level === "deep") ? deepRouter : runtimeRouter;
    const result = router.route({
      edges: edges.map((edge) => toGraphEdge(edge, atomsByKey, domains)),
      nodes: atoms.map((atom) => ({
        bounds: atomBounds(atom),
        id: atom.key,
      })),
      obstacles: domains.map((domain) => ({
        bounds: domainHeaderBounds(domain),
        id: `${domain.key}-header`,
        padding: 0,
      })),
    });
    const routesByKey = new Map(result.routes.map((route) => [route.id, route]));
    if (routesByKey.size !== edges.length) {
      throw new Error(`Flow layout routed ${routesByKey.size} of ${edges.length} edges.`);
    }

    const routedEdges = edges.map((edge) => {
      const key = edgeRouteKey(edge);
      const route = routesByKey.get(key);
      if (route === undefined) {
        throw new Error(`Flow layout route is missing: ${key}.`);
      }
      return {
        edge,
        key,
        points:
          edge.segmentOffsets === undefined
            ? route.points
            : offsetOrthogonalRoute(route.points, edge.segmentOffsets),
        route,
      };
    });
    const routePoints = routedEdges.flatMap(({ points }) => points);
    const minimumX =
      Math.min(...domains.map((domain) => domain.x), ...routePoints.map((point) => point.x)) -
      CANVAS_PADDING;
    const minimumY =
      Math.min(...domains.map((domain) => domain.y), ...routePoints.map((point) => point.y)) -
      CANVAS_PADDING;
    const positionedDomains = domains.map((domain) => ({
      ...domain,
      x: domain.x - minimumX,
      y: domain.y - minimumY,
    }));
    const positionedAtoms = atoms.map((atom) => ({
      ...atom,
      x: atom.x - minimumX,
      y: atom.y - minimumY,
    }));
    const positionedEdges = routedEdges.map(({ edge, key, points: routePath, route }) => {
      const points = routePath.map((point) => ({
        x: point.x - minimumX,
        y: point.y - minimumY,
      }));
      const startPoint = points[0];
      const endPoint = points.at(-1);
      if (startPoint === undefined || endPoint === undefined) {
        throw new Error(`Flow edge has incomplete endpoints: ${route.id}`);
      }
      return {
        ...edge,
        endPoint,
        fallback: route.fallback,
        key,
        length: routeLength(points),
        path: toRoundedSvgPath(points, EDGE_ROUNDING_RADIUS),
        points: [points],
        startPoint,
      };
    });
    const positionedRoutePoints = positionedEdges.flatMap((edge) => edge.points[0] ?? []);
    const maximumX = Math.max(
      ...positionedDomains.map((domain) => domain.x + domain.width),
      ...positionedAtoms.map((atom) => atom.x + atom.width),
      ...positionedRoutePoints.map((point) => point.x),
    );
    const maximumY = Math.max(
      ...positionedDomains.map((domain) => domain.y + domain.height),
      ...positionedAtoms.map((atom) => atom.y + ATOM_NODE_HEIGHT),
      ...positionedRoutePoints.map((point) => point.y),
    );
    return {
      atoms: positionedAtoms,
      diagnostics: result.diagnostics,
      domains: positionedDomains,
      edges: positionedEdges,
      height: maximumY + CANVAS_PADDING,
      metrics: result.metrics,
      width: maximumX + CANVAS_PADDING,
    };
  }
}

function toGraphEdge(
  edge: EdgeLayout,
  atomsByKey: ReadonlyMap<string, AtomLayout>,
  domains: readonly DomainLayout[],
): GraphEdge {
  const source = atomsByKey.get(edge.from);
  const target = atomsByKey.get(edge.to);
  const domain =
    source !== undefined && target !== undefined && source.domain === target.domain
      ? domains.find((candidate) => candidate.key === source.domain)
      : undefined;
  const routeBounds =
    edge.routeBounds ??
    (domain === undefined ||
    source === undefined ||
    target === undefined ||
    !domainContainsAtom(domain, source) ||
    !domainContainsAtom(domain, target)
      ? undefined
      : {
          height: domain.height,
          width: domain.width,
          x: domain.x,
          y: domain.y,
        });
  return {
    id: edgeRouteKey(edge),
    ...(routeBounds !== undefined ? { routeBounds } : {}),
    source: {
      nodeId: edge.from,
      ...endpointPort(edge.fromSide, edge.fromSlot, edge.fromMode),
    },
    target: {
      nodeId: edge.to,
      ...endpointPort(edge.toSide, edge.toSlot, edge.toMode),
    },
  };
}

function domainContainsAtom(domain: DomainLayout, atom: AtomLayout): boolean {
  return (
    atom.x >= domain.x &&
    atom.y >= domain.y &&
    atom.x + atom.width <= domain.x + domain.width &&
    atom.y + ATOM_NODE_HEIGHT <= domain.y + domain.height
  );
}

function endpointPort(
  side: EdgeLayout["fromSide"],
  slot: number | undefined,
  mode: EdgeLayout["fromMode"],
): { readonly port: PortConstraint } | Record<never, never> {
  if (side === undefined && slot === undefined && mode === undefined) {
    return {};
  }
  if (side === undefined) {
    return {
      port: {
        mode: mode ?? "preferred",
        ...(slot !== undefined ? { slot } : {}),
      },
    };
  }
  return {
    port: {
      mode: mode ?? "preferred",
      side,
      ...(slot !== undefined ? { slot } : {}),
    },
  };
}

function atomBounds(atom: AtomLayout): GraphRect {
  return {
    height: ATOM_NODE_HEIGHT,
    width: atom.width,
    x: atom.x,
    y: atom.y,
  };
}

function domainHeaderBounds(domain: DomainLayout): GraphRect {
  return {
    height: 36,
    width: Math.min(domain.width - 16, 190),
    x: domain.x + 8,
    y: domain.y - 14,
  };
}
