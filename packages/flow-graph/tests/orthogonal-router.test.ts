import { describe, expect, it } from "vitest";
import {
  expandRect,
  FlowGraphError,
  type FlowGraphInput,
  type GraphEdge,
  type GraphNode,
  isOrthogonalRoute,
  OrthogonalRouter,
  routeIntersectsRect,
} from "../src/index.js";

const nodeA: GraphNode = {
  bounds: { height: 40, width: 50, x: 0, y: 40 },
  id: "a",
};
const nodeB: GraphNode = {
  bounds: { height: 40, width: 50, x: 220, y: 40 },
  id: "b",
};
const edgeAB: GraphEdge = {
  id: "a-b",
  source: { nodeId: "a" },
  target: { nodeId: "b" },
};

describe("OrthogonalRouter", () => {
  it("routes a basic edge deterministically through outward ports", () => {
    const router = new OrthogonalRouter();
    const first = router.route({ edges: [edgeAB], nodes: [nodeA, nodeB] });
    const second = router.route({ edges: [edgeAB], nodes: [nodeA, nodeB] });
    const route = first.routes[0];

    expect(second).toEqual(first);
    expect(route).toMatchObject({
      fallback: false,
      id: "a-b",
      sourcePort: { side: "right" },
      targetPort: { side: "left" },
    });
    expect(route?.points.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonalRoute(route?.points ?? [])).toBe(true);
    expect(route?.path.startsWith("M ")).toBe(true);
    expect(first.metrics).toMatchObject({
      collisions: 0,
      fallbackCount: 0,
      routeCount: 1,
    });
  });

  it("chooses the shortest available route before preferred port sides", () => {
    const source: GraphNode = {
      bounds: { height: 40, width: 40, x: 0, y: 0 },
      id: "source",
    };
    const target: GraphNode = {
      bounds: { height: 40, width: 40, x: 100, y: 100 },
      id: "target",
    };
    const result = new OrthogonalRouter().route({
      edges: [
        {
          id: "nearest",
          source: {
            nodeId: "source",
            port: { mode: "preferred", side: "left", slot: 0.5 },
          },
          target: {
            nodeId: "target",
            port: { mode: "preferred", side: "right", slot: 0.5 },
          },
        },
      ],
      nodes: [source, target],
    });
    const route = result.routes[0];

    expect(route?.length).toBe(160);
    expect(route?.sourcePort.side).not.toBe("left");
    expect(route?.targetPort.side).not.toBe("right");
    expect(route?.metrics).toMatchObject({
      collisions: 0,
      overlap: 0,
    });
  });

  it("keeps independently routable edges on non-overlapping lanes", () => {
    const result = new OrthogonalRouter().route({
      edges: [
        {
          id: "upper",
          source: { nodeId: "source" },
          target: { nodeId: "upper-target" },
        },
        {
          id: "lower",
          source: { nodeId: "source" },
          target: { nodeId: "lower-target" },
        },
      ],
      nodes: [
        { bounds: { height: 40, width: 40, x: 0, y: 80 }, id: "source" },
        { bounds: { height: 40, width: 40, x: 220, y: 0 }, id: "upper-target" },
        { bounds: { height: 40, width: 40, x: 220, y: 160 }, id: "lower-target" },
      ],
    });

    expect(result.metrics.overlap).toBe(0);
    expect(result.routes.every((route) => route.metrics.overlap === 0)).toBe(true);
  });

  it("avoids expanded node and caller-provided obstacles", () => {
    const obstacle = {
      bounds: { height: 80, width: 60, x: 100, y: 20 },
      id: "panel",
    };
    const result = new OrthogonalRouter().route({
      edges: [edgeAB],
      nodes: [nodeA, nodeB],
      obstacles: [obstacle],
    });
    const route = result.routes[0];

    expect(route?.fallback).toBe(false);
    expect(routeIntersectsRect(route?.points ?? [], expandRect(obstacle.bounds, 8))).toBe(false);
    expect(route?.metrics.collisions).toBe(0);
  });

  it("keeps port stubs longer than obstacle clearance when configured", () => {
    const result = new OrthogonalRouter({
      clearance: 8,
      portStubLength: 18,
      roundingRadius: 4,
    }).route({
      edges: [
        {
          id: "long-stubs",
          source: {
            nodeId: "a",
            port: { mode: "fixed", side: "bottom", slot: 0.25 },
          },
          target: {
            nodeId: "b",
            port: { mode: "fixed", side: "top", slot: 0.75 },
          },
        },
      ],
      nodes: [nodeA, nodeB],
    });
    const route = result.routes[0];
    const points = route?.points ?? [];

    expect(pointDistance(route?.sourcePort.point, route?.sourcePort.exit)).toBe(18);
    expect(pointDistance(route?.targetPort.point, route?.targetPort.exit)).toBe(18);
    expect(pointDistance(points[0], points[1])).toBeGreaterThanOrEqual(18);
    expect(pointDistance(points.at(-2), points.at(-1))).toBeGreaterThanOrEqual(18);
  });

  it("uses a direct facing route when adjacent nodes are closer than two port stubs", () => {
    const closeTarget: GraphNode = {
      bounds: { height: 40, width: 50, x: 70, y: 40 },
      id: "close-target",
    };
    const result = new OrthogonalRouter({
      clearance: 8,
      portStubLength: 18,
    }).route({
      edges: [
        {
          id: "close-facing",
          source: { nodeId: "a", port: { mode: "fixed", side: "right", slot: 0.5 } },
          target: {
            nodeId: "close-target",
            port: { mode: "fixed", side: "left", slot: 0.5 },
          },
        },
      ],
      nodes: [nodeA, closeTarget],
    });

    expect(result.routes[0]).toMatchObject({
      fallback: false,
      length: 20,
      points: [
        { x: 50, y: 60 },
        { x: 70, y: 60 },
      ],
    });
  });

  it("distributes fan-out ports and ignores input ordering", () => {
    const targets: GraphNode[] = [
      { bounds: { height: 40, width: 50, x: 220, y: 0 }, id: "top" },
      { bounds: { height: 40, width: 50, x: 220, y: 80 }, id: "middle" },
      { bounds: { height: 40, width: 50, x: 220, y: 160 }, id: "bottom" },
    ];
    const edges: GraphEdge[] = targets.map((target) => ({
      id: `a-${target.id}`,
      source: { nodeId: "a" },
      target: { nodeId: target.id },
    }));
    const router = new OrthogonalRouter();
    const forward = router.route({ edges, nodes: [nodeA, ...targets] });
    const reversed = router.route({
      edges: [...edges].reverse(),
      nodes: [...targets, nodeA].reverse(),
    });

    expect(reversed).toEqual(forward);
    expect(
      new Set(
        forward.routes.map((route) => `${route.sourcePort.point.x}:${route.sourcePort.point.y}`),
      ).size,
    ).toBe(3);
  });

  it("honors fixed ports and creates a non-zero self loop", () => {
    const fixed = new OrthogonalRouter().route({
      edges: [
        {
          id: "fixed",
          source: {
            nodeId: "a",
            port: { mode: "fixed", side: "bottom", slot: 0.25 },
          },
          target: {
            nodeId: "b",
            port: { mode: "fixed", side: "top", slot: 0.75 },
          },
        },
      ],
      nodes: [nodeA, nodeB],
    });
    const loop = new OrthogonalRouter().route({
      edges: [{ id: "loop", source: { nodeId: "a" }, target: { nodeId: "a" } }],
      nodes: [nodeA],
    });

    expect(fixed.routes[0]).toMatchObject({
      sourcePort: { side: "bottom", slot: 0.25 },
      targetPort: { side: "top", slot: 0.75 },
    });
    expect(loop.routes[0]?.length).toBeGreaterThan(0);
    expect(loop.routes[0]?.points[0]).toEqual(loop.routes[0]?.sourcePort.point);
    expect(loop.routes[0]?.points.at(-1)).toEqual(loop.routes[0]?.targetPort.point);
  });

  it("returns diagnostics and a visible fallback when every exit is blocked", () => {
    const result = new OrthogonalRouter({ maxOptimizationPasses: 1 }).route({
      edges: [edgeAB],
      nodes: [nodeA, nodeB],
      obstacles: [
        {
          bounds: { height: 140, width: 310, x: -20, y: -10 },
          id: "sealed",
          padding: 0,
        },
      ],
    });
    const route = result.routes[0];

    expect(route?.fallback).toBe(true);
    expect(route?.path.startsWith("M ")).toBe(true);
    expect(route?.metrics.collisions).toBeGreaterThan(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "ROUTE_COLLISION_FALLBACK",
    );
  });

  it("reports fixed port reuse without silently moving the ports", () => {
    const targetC: GraphNode = {
      bounds: { height: 40, width: 50, x: 220, y: 140 },
      id: "c",
    };
    const port = { mode: "fixed" as const, side: "right" as const, slot: 0.5 };
    const result = new OrthogonalRouter().route({
      edges: [
        { id: "a-b", source: { nodeId: "a", port }, target: { nodeId: "b" } },
        { id: "a-c", source: { nodeId: "a", port }, target: { nodeId: "c" } },
      ],
      nodes: [nodeA, nodeB, targetC],
    });

    expect(result.routes.map((route) => route.sourcePort.point)).toEqual([
      { x: 50, y: 60 },
      { x: 50, y: 60 },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "ROUTE_PORT_REUSED_BY_CONSTRAINT",
    );
  });

  it("rejects malformed runtime input with stable flow graph errors", () => {
    const router = new OrthogonalRouter();

    expectFlowGraphError(
      () => router.route(undefined as unknown as FlowGraphInput),
      "FLOW_GRAPH_INVALID_INPUT",
      undefined,
    );
    expectFlowGraphError(
      () => router.route({ edges: [] } as unknown as FlowGraphInput),
      "FLOW_GRAPH_INVALID_INPUT",
      "nodes",
    );
    expectFlowGraphError(
      () => router.route({ edges: [], nodes: [nodeA, nodeA] }),
      "FLOW_GRAPH_DUPLICATE_ID",
      "nodes[1].id",
    );
    expectFlowGraphError(
      () =>
        router.route({
          edges: [{ ...edgeAB, target: { nodeId: "missing" } }],
          nodes: [nodeA],
        }),
      "FLOW_GRAPH_UNKNOWN_ENDPOINT",
      "edges[0].target.nodeId",
    );
    expectFlowGraphError(
      () =>
        router.route({
          edges: [],
          nodes: [{ ...nodeA, bounds: { ...nodeA.bounds, width: 0 } }],
        }),
      "FLOW_GRAPH_INVALID_BOUNDS",
      "nodes[0].bounds.width",
    );
    expectFlowGraphError(
      () =>
        router.route({
          edges: [
            {
              ...edgeAB,
              source: {
                nodeId: "a",
                port: { mode: "fixed", side: "right", slot: 2 },
              },
            },
          ],
          nodes: [nodeA, nodeB],
        }),
      "FLOW_GRAPH_INVALID_PORT",
      "edges[0].source.port.slot",
    );
    expectFlowGraphError(
      () =>
        router.route({
          edges: [
            {
              ...edgeAB,
              routeBounds: { height: 50, width: 100, x: 0, y: 30 },
            },
          ],
          nodes: [nodeA, nodeB],
        }),
      "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
      "edges[0].routeBounds",
    );
  });

  it("accepts empty graphs and validates router limits", () => {
    expect(new OrthogonalRouter().route({ edges: [], nodes: [] })).toEqual({
      diagnostics: [],
      metrics: {
        bends: 0,
        collisions: 0,
        crossings: 0,
        fallbackCount: 0,
        length: 0,
        optimizationPasses: 0,
        overlap: 0,
        portDeviation: 0,
        proximity: 0,
        routeCount: 0,
      },
      routes: [],
    });
    expect(() => new OrthogonalRouter({ clearance: 0 })).toThrow(FlowGraphError);
  });

  it("validates limits, options, obstacles, IDs, and complete port contracts", () => {
    const custom = new OrthogonalRouter({
      bendPenalty: 0,
      clearance: 4,
      crossingPenalty: 0,
      maxCoordinatesPerAxis: 8,
      maxEdges: 2,
      maxNodes: 2,
      maxOptimizationPasses: 0,
      overlapPenalty: 0,
      parallelGap: 4,
      portDeviationPenalty: 0,
      portStubLength: 4,
      proximityPenalty: 0,
      roundingRadius: 0,
    });
    expect(custom.route({ edges: [edgeAB], nodes: [nodeA, nodeB] }).routes).toHaveLength(1);

    for (const options of [
      { bendPenalty: -1 },
      { crossingPenalty: Number.NaN },
      { maxCoordinatesPerAxis: 0 },
      { maxEdges: 1.5 },
      { maxNodes: 0 },
      { maxOptimizationPasses: -1 },
      { overlapPenalty: -1 },
      { parallelGap: 0 },
      { portDeviationPenalty: -1 },
      { portStubLength: 0 },
      { proximityPenalty: -1 },
      { roundingRadius: -1 },
    ]) {
      expect(() => new OrthogonalRouter(options)).toThrow(FlowGraphError);
    }

    expectFlowGraphError(
      () => new OrthogonalRouter({ maxNodes: 1 }).route({ edges: [], nodes: [nodeA, nodeB] }),
      "FLOW_GRAPH_INVALID_INPUT",
      "nodes",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter({ maxEdges: 1 }).route({
          edges: [edgeAB, { ...edgeAB, id: "second" }],
          nodes: [nodeA, nodeB],
        }),
      "FLOW_GRAPH_INVALID_INPUT",
      "edges",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [],
          nodes: [nodeA],
          obstacles: [
            { bounds: nodeB.bounds, id: "same" },
            { bounds: nodeB.bounds, id: "same" },
          ],
        }),
      "FLOW_GRAPH_DUPLICATE_ID",
      "obstacles[1].id",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [edgeAB, { ...edgeAB }],
          nodes: [nodeA, nodeB],
        }),
      "FLOW_GRAPH_DUPLICATE_ID",
      "edges[1].id",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [],
          nodes: [null as unknown as GraphNode],
        }),
      "FLOW_GRAPH_INVALID_INPUT",
      "nodes[0]",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [],
          nodes: [{ ...nodeA, id: " " }],
        }),
      "FLOW_GRAPH_INVALID_INPUT",
      "nodes[0].id",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [],
          nodes: [{ ...nodeA, bounds: { ...nodeA.bounds, x: Number.POSITIVE_INFINITY } }],
        }),
      "FLOW_GRAPH_INVALID_BOUNDS",
      "nodes[0].bounds.x",
    );
    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [],
          nodes: [nodeA],
          obstacles: [{ bounds: nodeB.bounds, id: "bad", padding: -1 }],
        }),
      "FLOW_GRAPH_INVALID_BOUNDS",
      "obstacles[0].padding",
    );

    for (const port of [
      { mode: "unknown" },
      { mode: "fixed" },
      { mode: "preferred", side: "diagonal" },
    ]) {
      expectFlowGraphError(
        () =>
          new OrthogonalRouter().route({
            edges: [
              {
                ...edgeAB,
                source: {
                  nodeId: "a",
                  port: port as never,
                },
              },
            ],
            nodes: [nodeA, nodeB],
          }),
        "FLOW_GRAPH_INVALID_PORT",
        expect.stringContaining("edges[0].source.port") as unknown as string,
      );
    }
  });

  it("supports valid route bounds, preferred ports, reverse direction, and fixed-bound failures", () => {
    const routeBounds = { height: 100, width: 280, x: -5, y: 10 };
    const result = new OrthogonalRouter({ maxCoordinatesPerAxis: 4 }).route({
      edges: [
        {
          ...edgeAB,
          routeBounds,
          source: {
            nodeId: "a",
            port: { mode: "preferred", side: "top", slot: 0.2 },
          },
          target: {
            nodeId: "b",
            port: { mode: "preferred", side: "bottom", slot: 0.8 },
          },
        },
      ],
      nodes: [nodeB, nodeA],
      obstacles: [{ bounds: { height: 20, width: 40, x: 110, y: 50 }, id: "middle" }],
    });
    const route = result.routes[0];

    expect(
      route?.points.every(
        (point) =>
          point.x >= routeBounds.x &&
          point.x <= routeBounds.x + routeBounds.width &&
          point.y >= routeBounds.y &&
          point.y <= routeBounds.y + routeBounds.height,
      ),
    ).toBe(true);

    const reverse = new OrthogonalRouter().route({
      edges: [{ id: "reverse", source: { nodeId: "b" }, target: { nodeId: "a" } }],
      nodes: [nodeA, { ...nodeB, bounds: { ...nodeB.bounds, y: -80 } }],
    });
    expect(["left", "bottom"]).toContain(reverse.routes[0]?.sourcePort.side);
    expect(["right", "top"]).toContain(reverse.routes[0]?.targetPort.side);

    expectFlowGraphError(
      () =>
        new OrthogonalRouter().route({
          edges: [
            {
              ...edgeAB,
              routeBounds: { height: 40, width: 270, x: 0, y: 40 },
              source: { nodeId: "a", port: { mode: "fixed", side: "top" } },
              target: { nodeId: "b", port: { mode: "fixed", side: "top" } },
            },
          ],
          nodes: [nodeA, nodeB],
        }),
      "FLOW_GRAPH_INVALID_ROUTE_BOUNDS",
      "edges.a-b.routeBounds",
    );
  });

  it("diagnoses forced overlap, crossing, proximity, and optimization limits", () => {
    const fixedRight = { mode: "fixed" as const, side: "right" as const, slot: 0.5 };
    const fixedLeft = { mode: "fixed" as const, side: "left" as const, slot: 0.5 };
    const overlap = new OrthogonalRouter({ maxOptimizationPasses: 0 }).route({
      edges: [
        {
          id: "same-1",
          source: { nodeId: "a", port: fixedRight },
          target: { nodeId: "b", port: fixedLeft },
        },
        {
          id: "same-2",
          source: { nodeId: "a", port: fixedRight },
          target: { nodeId: "b", port: fixedLeft },
        },
      ],
      nodes: [nodeA, nodeB],
    });
    expect(overlap.metrics.overlap).toBeGreaterThan(0);
    expect(overlap.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "ROUTE_OPTIMIZATION_LIMIT",
        "ROUTE_OVERLAP_REMAINS",
        "ROUTE_PORT_REUSED_BY_CONSTRAINT",
      ]),
    );

    const left = { bounds: { height: 20, width: 20, x: 0, y: 100 }, id: "left" };
    const right = { bounds: { height: 20, width: 20, x: 300, y: 100 }, id: "right" };
    const top = { bounds: { height: 20, width: 20, x: 150, y: 0 }, id: "top" };
    const bottom = { bounds: { height: 20, width: 20, x: 150, y: 200 }, id: "bottom" };
    const crossing = new OrthogonalRouter({ maxOptimizationPasses: 0 }).route({
      edges: [
        {
          id: "horizontal",
          source: { nodeId: "left", port: fixedRight },
          target: { nodeId: "right", port: fixedLeft },
        },
        {
          id: "vertical",
          source: {
            nodeId: "top",
            port: { mode: "fixed", side: "bottom", slot: 0.5 },
          },
          target: {
            nodeId: "bottom",
            port: { mode: "fixed", side: "top", slot: 0.5 },
          },
        },
      ],
      nodes: [left, right, top, bottom],
    });
    expect(crossing.metrics.crossings).toBe(1);
    expect(crossing.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "ROUTE_CROSSING_REMAINS",
    );

    const proximity = new OrthogonalRouter({
      maxOptimizationPasses: 0,
      parallelGap: 16,
    }).route({
      edges: [
        {
          id: "parallel-1",
          routeBounds: { height: 14, width: 320, x: 0, y: 50 },
          source: { nodeId: "left-1", port: fixedRight },
          target: { nodeId: "right-1", port: fixedLeft },
        },
        {
          id: "parallel-2",
          routeBounds: { height: 14, width: 320, x: 0, y: 50 },
          source: { nodeId: "left-2", port: fixedRight },
          target: { nodeId: "right-2", port: fixedLeft },
        },
      ],
      nodes: [
        { bounds: { height: 4, width: 20, x: 0, y: 50 }, id: "left-1" },
        { bounds: { height: 4, width: 20, x: 300, y: 50 }, id: "right-1" },
        { bounds: { height: 4, width: 20, x: 0, y: 60 }, id: "left-2" },
        { bounds: { height: 4, width: 20, x: 300, y: 60 }, id: "right-2" },
      ],
    });
    expect(proximity.metrics.proximity).toBeGreaterThan(0);
    expect(proximity.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "ROUTE_PROXIMITY_REMAINS",
    );
  });

  it("supports a fixed same-port self loop", () => {
    const port = { mode: "fixed" as const, side: "right" as const, slot: 0.5 };
    const result = new OrthogonalRouter().route({
      edges: [
        {
          id: "fixed-loop",
          source: { nodeId: "a", port },
          target: { nodeId: "a", port },
        },
      ],
      nodes: [nodeA],
    });

    expect(result.routes[0]?.length).toBeGreaterThan(0);
    expect(result.routes[0]?.sourcePort).toEqual(result.routes[0]?.targetPort);
  });
});

function expectFlowGraphError(
  run: () => unknown,
  code: FlowGraphError["code"],
  path: string | undefined,
): void {
  try {
    run();
    throw new Error("Expected FlowGraphError.");
  } catch (error) {
    expect(error).toBeInstanceOf(FlowGraphError);
    expect(error).toMatchObject({
      code,
      path,
    });
  }
}

function pointDistance(
  left: { readonly x: number; readonly y: number } | undefined,
  right: { readonly x: number; readonly y: number } | undefined,
): number {
  return left === undefined || right === undefined
    ? 0
    : Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}
