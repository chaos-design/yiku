import { type GraphRect, routeIntersectsRect } from "@yiku/flow-graph";
import { describe, expect, it } from "vitest";
import {
  ATOM_NODE_HEIGHT,
  ATOMS,
  type DOMAINS,
  dynamicAtomLayouts,
  EDGES,
  edgeRouteKey,
} from "../../src/data/atom-layout.js";
import { FlowLayoutEngine } from "../../src/data/flow-layout.js";

describe("FlowLayoutEngine", () => {
  it("fills runtime and deep views with deterministic orthogonal routes", async () => {
    const engine = new FlowLayoutEngine();
    const first = await engine.layout(ATOMS, EDGES);
    const reordered = await engine.layout([...ATOMS].reverse(), [...EDGES].reverse());
    const runtimeAtoms = ATOMS.filter((atom) => atom.level === "runtime");
    const runtimeAtomKeys = new Set(runtimeAtoms.map((atom) => atom.key));
    const runtimeEdges = EDGES.filter(
      (edge) => runtimeAtomKeys.has(edge.from) && runtimeAtomKeys.has(edge.to),
    );
    const runtime = await engine.layout(runtimeAtoms, runtimeEdges);

    expect(reordered.metrics).toEqual(first.metrics);
    expect(reordered.diagnostics).toEqual(first.diagnostics);
    expect(reordered.edges.toSorted(byEdgeKey)).toEqual(first.edges.toSorted(byEdgeKey));
    expect(first.width / first.height).toBeLessThan(2);
    expect(first.atoms.map((atom) => atom.key).toSorted()).toEqual(
      ATOMS.map((atom) => atom.key).toSorted(),
    );
    expect(first.edges.map((edge) => edge.key).toSorted()).toEqual(
      EDGES.map(edgeRouteKey).toSorted(),
    );
    expect(runtime.atoms).toHaveLength(runtimeAtoms.length);
    expect(runtime.edges).toHaveLength(runtimeEdges.length);
    expectClearGeometry(first, 14);
    expectClearGeometry(runtime, 15);
    expect(first.metrics).toMatchObject({
      collisions: 0,
      fallbackCount: 0,
      overlap: 0,
    });
    expect(first.metrics.bends / first.edges.length).toBeLessThan(2.25);
    expect(first.metrics.crossings / first.edges.length).toBeLessThan(0.25);
    expect(reciprocalEdges(first.edges)).toEqual([]);
    expect(first.domains.map((domain) => domain.key)).toEqual([
      "session",
      "execution",
      "memory",
      "capabilities",
      "telemetry",
      "quality",
    ]);

    const domains = new Map(first.domains.map((domain) => [domain.key, domain]));
    expect(domains.get("session")?.width).toBeGreaterThanOrEqual(250);
    expect(domains.get("session")?.x).toBeLessThan(domains.get("execution")?.x ?? 0);
    expect(domains.get("execution")?.x).toBe(domains.get("memory")?.x);
    expect(domains.get("execution")?.y).toBeLessThan(domains.get("memory")?.y ?? 0);
    expect(domains.get("memory")?.width).toBeGreaterThan(domains.get("execution")?.width ?? 0);
    expect((domains.get("memory")?.x ?? 0) + (domains.get("memory")?.width ?? 0)).toBe(
      (domains.get("capabilities")?.x ?? 0) + (domains.get("capabilities")?.width ?? 0),
    );
    expect(domains.get("capabilities")?.x).toBeGreaterThan(domains.get("execution")?.x ?? 0);
    expect(domains.get("quality")?.x).toBeGreaterThan(domains.get("capabilities")?.x ?? 0);
    expect(domains.get("quality")?.y).toBe(domains.get("capabilities")?.y);
    expect(domains.get("telemetry")?.x).toBe(domains.get("quality")?.x);
    expect(domains.get("telemetry")?.y).toBeGreaterThan(domains.get("quality")?.y ?? 0);

    const topDomains = ["session", "execution", "capabilities", "quality"] as const;
    const topDomainY = domains.get("session")?.y ?? 0;
    expect(topDomains.map((key) => domains.get(key)?.y)).toEqual([
      topDomainY,
      topDomainY,
      topDomainY,
      topDomainY,
    ]);
    const memoryDomain = domains.get("memory");
    const capabilityDomain = domains.get("capabilities");
    expect((memoryDomain?.y ?? 0) - topDomainY).toBe(468);
    expect(capabilityDomain?.height).toBe(430);
    expect(
      (memoryDomain?.y ?? 0) - ((capabilityDomain?.y ?? 0) + (capabilityDomain?.height ?? 0)),
    ).toBeGreaterThanOrEqual(30);
    const memoryAtoms = first.atoms.filter((atom) => atom.domain === "memory");
    const capabilityAtoms = first.atoms.filter((atom) => atom.domain === "capabilities");
    const memoryRight = Math.max(...memoryAtoms.map((atom) => atom.x + atom.width));
    const capabilityBottom = Math.max(...capabilityAtoms.map((atom) => atom.y + ATOM_NODE_HEIGHT));
    expect(memoryRight - (memoryDomain?.x ?? 0)).toBeGreaterThanOrEqual(
      (memoryDomain?.width ?? 0) * 0.7,
    );
    expect(
      (capabilityDomain?.y ?? 0) + (capabilityDomain?.height ?? 0) - capabilityBottom,
    ).toBeGreaterThanOrEqual(40);

    const hookDispatch = first.atoms.find((atom) => atom.key === "hook.dispatch");
    const hookExecute = first.atoms.find((atom) => atom.key === "hook.execute");
    expect(hookDispatch).toBeDefined();
    expect(hookExecute).toBeDefined();
    expect(
      (hookExecute?.x ?? 0) - ((hookDispatch?.x ?? 0) + (hookDispatch?.width ?? 0)),
    ).toBeGreaterThanOrEqual(18);
    const sessionDomain = domains.get("session");
    expect((hookDispatch?.x ?? 0) - (sessionDomain?.x ?? 0)).toBeGreaterThanOrEqual(20);
    expect(
      (sessionDomain?.x ?? 0) +
        (sessionDomain?.width ?? 0) -
        ((hookExecute?.x ?? 0) + (hookExecute?.width ?? 0)),
    ).toBeGreaterThanOrEqual(20);
    const stageInput = first.edges.find(
      (edge) => edge.from === "stage.start" && edge.to === "input.prompt",
    );
    expect(stageInput).toBeDefined();

    const runToLoop = first.edges.find((edge) => edge.from === "run" && edge.to === "loop.turn");
    const runToLoopPoints = runToLoop?.points[0] ?? [];
    expect(runToLoopPoints[0]).toEqual(runToLoop?.startPoint);
    expect(runToLoopPoints.at(-1)).toEqual(runToLoop?.endPoint);

    const observationFeedback = first.edges.find(
      (edge) => edge.from === "observation" && edge.to === "loop.turn",
    );
    const feedbackPoints = observationFeedback?.points[0] ?? [];
    expect(feedbackPoints[0]).toEqual(observationFeedback?.startPoint);
    expect(feedbackPoints.at(-1)).toEqual(observationFeedback?.endPoint);

    const finalToEval = first.edges.find(
      (edge) => edge.from === "reply.final" && edge.to === "eval.trigger",
    );
    const finalToExtract = first.edges.find(
      (edge) => edge.from === "reply.final" && edge.to === "memory.extract",
    );
    const finalReply = first.atoms.find((atom) => atom.key === "reply.final");
    const memoryExtract = first.atoms.find((atom) => atom.key === "memory.extract");
    expect(finalToEval).toBeDefined();
    expect(finalToExtract).toBeDefined();
    expect(finalToExtract?.startPoint.y).toBe((finalReply?.y ?? 0) + ATOM_NODE_HEIGHT);
    expect(finalToExtract?.endPoint.y).toBe(memoryExtract?.y);
    expect(finalToExtract?.length).toBeLessThan(1_300);
    expect(finalToEval?.startPoint).not.toEqual(finalToExtract?.startPoint);
    expect(
      sharedRouteSegments(
        [finalToEval, finalToExtract].filter(
          (edge): edge is NonNullable<typeof edge> => edge !== undefined,
        ),
      ),
    ).toEqual([]);

    expectVisibleTraceBridge(first);

    const scorecardInputs = first.edges.filter((edge) => edge.to === "eval.scorecard");
    expect(scorecardInputs).toHaveLength(1);
    expect(scorecardInputs[0]?.from).toBe("eval.trigger");

    const taskSnapshotOutputs = first.edges.filter((edge) => edge.from === "task.snapshot");
    const agentProfileInput = first.edges.find(
      (edge) => edge.from === "task.snapshot" && edge.to === "agent.profile",
    );
    const agentProfile = first.atoms.find((atom) => atom.key === "agent.profile");
    expect(taskSnapshotOutputs).toHaveLength(2);
    expect(
      new Set(taskSnapshotOutputs.map((edge) => `${edge.startPoint.x}:${edge.startPoint.y}`)).size,
    ).toBe(taskSnapshotOutputs.length);
    expect(agentProfileInput?.to).toBe(agentProfile?.key);

    const qualityDomain = domains.get("quality");
    const triggerOutputs = first.edges.filter(
      (edge) => edge.from === "eval.trigger" && edge.to !== "eval.scorecard",
    );
    const evaluatorRoutes = [
      ...triggerOutputs,
      ...scorecardInputs,
      ...first.edges.filter((edge) => edge.from === "eval.scorecard"),
    ];
    expect(qualityDomain?.width).toBe(604);
    expect(triggerOutputs).toHaveLength(4);
    expect(crossingRoutes(evaluatorRoutes).length).toBeLessThanOrEqual(4);
    expect(sharedRouteSegments(evaluatorRoutes)).toEqual([]);
    expect(
      evaluatorRoutes.every((edge) =>
        edge.points[0]?.every(
          (point) =>
            point.x >= (qualityDomain?.x ?? 0) &&
            point.x <= (qualityDomain?.x ?? 0) + (qualityDomain?.width ?? 0) &&
            point.y >= (qualityDomain?.y ?? 0) &&
            point.y <= (qualityDomain?.y ?? 0) + (qualityDomain?.height ?? 0),
        ),
      ),
    ).toBe(true);
  }, 120_000);

  it("applies configured segment offsets after routing and recomputes rendered length", async () => {
    const source = ATOMS.find((atom) => atom.key === "tool.call");
    const target = ATOMS.find((atom) => atom.key === "user.question");
    if (source === undefined || target === undefined) {
      throw new Error("Expected fixed input atoms.");
    }
    const edge = {
      from: source.key,
      fromSide: "right",
      fromSlot: 0.5,
      kind: "execution",
      to: target.key,
      toSide: "left",
      toSlot: 0.5,
    } as const;
    const engine = new FlowLayoutEngine();
    const base = await engine.layout([source, target], [edge]);
    const shifted = await engine.layout([source, target], [{ ...edge, segmentOffsets: { 1: 10 } }]);
    const baseRoute = base.edges[0];
    const shiftedRoute = shifted.edges[0];

    expect(baseRoute).toBeDefined();
    expect(shiftedRoute).toBeDefined();
    expect(shiftedRoute?.key).toBe(baseRoute?.key);
    expect(shiftedRoute?.startPoint).toEqual(baseRoute?.startPoint);
    expect(shiftedRoute?.endPoint).toEqual(baseRoute?.endPoint);
    expect(shiftedRoute?.points[0]).toEqual([
      baseRoute?.startPoint,
      {
        x: (baseRoute?.startPoint.x ?? 0) + 10,
        y: baseRoute?.startPoint.y,
      },
      {
        x: (baseRoute?.endPoint.x ?? 0) + 10,
        y: baseRoute?.endPoint.y,
      },
      baseRoute?.endPoint,
    ]);
    expect(shiftedRoute?.length).toBe((baseRoute?.length ?? 0) + 20);
    expect(shiftedRoute?.path).not.toBe(baseRoute?.path);
  });

  it("routes a dynamic Research domain without changing fixed domain geometry", async () => {
    const run = ATOMS.find((atom) => atom.key === "run");
    if (run === undefined) {
      throw new Error("Expected Run atom.");
    }
    const researchAtoms = dynamicAtomLayouts([
      {
        key: "research.plan",
        kind: "context",
        label: "Research Plan",
        level: "runtime",
      },
      {
        key: "research.search",
        kind: "tool",
        label: "Web Search",
        level: "runtime",
      },
      {
        key: "research.report",
        kind: "reply",
        label: "Research Report",
        level: "runtime",
      },
    ]);
    const edges = [
      {
        from: "run",
        kind: "execution" as const,
        to: "research.plan",
      },
      {
        from: "research.plan",
        kind: "execution" as const,
        to: "research.search",
      },
      {
        from: "research.search",
        kind: "execution" as const,
        to: "research.report",
      },
    ];
    const layout = await new FlowLayoutEngine().layout([run, ...researchAtoms], edges);
    const researchDomain = layout.domains.find((domain) => domain.key === "agent:research");

    expect(researchDomain).toBeDefined();
    expect(layout.edges).toHaveLength(edges.length);
    expect(layout.metrics).toMatchObject({
      collisions: 0,
      fallbackCount: 0,
    });
    expect(
      layout.atoms
        .filter((atom) => atom.domain === "agent:research")
        .every(
          (atom) =>
            atom.x >= (researchDomain?.x ?? 0) &&
            atom.x + atom.width <= (researchDomain?.x ?? 0) + (researchDomain?.width ?? 0),
        ),
    ).toBe(true);
  });

  it("routes overflowing dynamic evaluator edges without applying stale domain bounds", async () => {
    const atoms = dynamicAtomLayouts([
      {
        key: "eval.attempt",
        kind: "eval",
        label: "Eval Attempt",
        level: "runtime",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        key: `eval.custom-${index}`,
        kind: "eval" as const,
        label: `Custom Evaluator ${index}`,
        level: "runtime" as const,
      })),
      {
        key: "eval.resource-budget",
        kind: "eval",
        label: "Resource Budget",
        level: "runtime",
      },
    ]);
    const resourceBudget = atoms.find((atom) => atom.key === "eval.resource-budget");

    expect(resourceBudget?.y).toBeGreaterThan(696);

    const layout = await new FlowLayoutEngine().layout(atoms, [
      {
        from: "eval.attempt",
        kind: "execution",
        to: "eval.resource-budget",
      },
    ]);
    const positionedResourceBudget = layout.atoms.find(
      (atom) => atom.key === "eval.resource-budget",
    );

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.key).toBe("eval.attempt:eval.resource-budget:execution");
    expect(
      (positionedResourceBudget?.y ?? Number.POSITIVE_INFINITY) + ATOM_NODE_HEIGHT,
    ).toBeLessThanOrEqual(layout.height);
  });

  it("rejects missing graph arrays with stable domain errors", async () => {
    const engine = new FlowLayoutEngine();

    await expect(engine.layout(undefined as unknown as typeof ATOMS, EDGES)).rejects.toMatchObject({
      code: "FLOW_GRAPH_INVALID_INPUT",
      path: "atoms",
    });
    await expect(engine.layout(ATOMS, undefined as unknown as typeof EDGES)).rejects.toMatchObject({
      code: "FLOW_GRAPH_INVALID_INPUT",
      path: "edges",
    });
  });
});

type Layout = Awaited<ReturnType<FlowLayoutEngine["layout"]>>;

function byEdgeKey(left: Layout["edges"][number], right: Layout["edges"][number]): number {
  return left.key.localeCompare(right.key);
}

function expectVisibleTraceBridge(layout: Layout): void {
  const traceBridge = layout.edges.find(
    (edge) => edge.from === "run" && edge.to === "trace.append",
  );
  const memoryRight = Math.max(
    ...layout.atoms.filter((atom) => atom.domain === "memory").map((atom) => atom.x + atom.width),
  );
  const clearCorridor = edgeSegments(traceBridge?.points[0] ?? []).find(
    (segment) =>
      segment.from.x === segment.to.x &&
      segment.from.x >= memoryRight + 48 &&
      Math.abs(segment.to.y - segment.from.y) >= 200,
  );

  expect(traceBridge).toBeDefined();
  expect(clearCorridor).toBeDefined();
  expect(
    traceBridge?.points[0]?.every(
      (point) =>
        point.x >= 0 && point.x <= layout.width && point.y >= 0 && point.y <= layout.height,
    ),
  ).toBe(true);
}

function expectClearGeometry(layout: Layout, maximumCrossings: number): void {
  expect(layout.edges.every((edge) => edge.path.startsWith("M "))).toBe(true);
  expect(layout.edges.every((edge) => edge.length > 0)).toBe(true);
  expect(
    layout.edges.every((edge) =>
      edge.points[0]?.every(
        (point) =>
          point.x >= 12 &&
          point.x <= layout.width - 12 &&
          point.y >= 12 &&
          point.y <= layout.height - 12,
      ),
    ),
  ).toBe(true);
  expect(overlappingAtoms(layout.atoms)).toEqual([]);
  expect(closeAtomPairs(layout.atoms)).toEqual([]);
  expect(
    layout.atoms.flatMap((atom) => {
      const domain = layout.domains.find((candidate) => candidate.key === atom.domain);
      const bounds = atomBounds(atom);
      return domain !== undefined &&
        bounds.x >= domain.x &&
        bounds.y >= domain.y &&
        bounds.x + bounds.width <= domain.x + domain.width &&
        bounds.y + bounds.height <= domain.y + domain.height
        ? []
        : [atom.key];
    }),
  ).toEqual([]);
  expect(reusedPorts(layout.edges, "from")).toEqual([]);
  expect(reusedPorts(layout.edges, "to")).toEqual([]);
  expect(sharedRouteSegments(layout.edges)).toEqual([]);
  expect(closeParallelRouteSegments(layout.edges)).toEqual([]);
  expect(invalidEndpointRoutes(layout)).toEqual([]);
  expect(shortEndpointSegments(layout.edges)).toEqual([]);
  const crossings = crossingRoutes(layout.edges);
  expect(crossings.length, crossings.join("\n")).toBeLessThanOrEqual(maximumCrossings);
  expect(
    layout.edges.flatMap((edge) =>
      layout.atoms.flatMap((atom) =>
        atom.key !== edge.from &&
        atom.key !== edge.to &&
        routeIntersectsRect(edge.points[0] ?? [], atomBounds(atom))
          ? [`${edge.key} <> ${atom.key}`]
          : [],
      ),
    ),
  ).toEqual([]);
  expect(
    layout.edges.flatMap((edge) =>
      layout.domains.flatMap((domain) =>
        routeIntersectsRect(edge.points[0] ?? [], domainHeaderBounds(domain))
          ? [`${edge.key} <> ${domain.key}`]
          : [],
      ),
    ),
  ).toEqual([]);
}

function invalidEndpointRoutes(layout: Layout): readonly string[] {
  const atomsByKey = new Map(layout.atoms.map((atom) => [atom.key, atom]));
  return layout.edges.flatMap((edge) => {
    const source = atomsByKey.get(edge.from);
    const target = atomsByKey.get(edge.to);
    const points = edge.points[0] ?? [];
    const afterStart = points[1];
    const beforeEnd = points.at(-2);
    if (
      source === undefined ||
      target === undefined ||
      afterStart === undefined ||
      beforeEnd === undefined
    ) {
      return [edge.key];
    }
    return pointExitsAtom(edge.startPoint, afterStart, atomBounds(source)) &&
      pointExitsAtom(edge.endPoint, beforeEnd, atomBounds(target))
      ? []
      : [edge.key];
  });
}

function pointExitsAtom(
  point: TestSegment["from"],
  outside: TestSegment["from"],
  bounds: GraphRect,
): boolean {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return (
    (point.x === bounds.x && outside.x < point.x && outside.y === point.y) ||
    (point.x === right && outside.x > point.x && outside.y === point.y) ||
    (point.y === bounds.y && outside.y < point.y && outside.x === point.x) ||
    (point.y === bottom && outside.y > point.y && outside.x === point.x)
  );
}

function atomBounds(atom: (typeof ATOMS)[number]): GraphRect {
  return {
    height: ATOM_NODE_HEIGHT,
    key: atom.key,
    width: atom.width,
    x: atom.x,
    y: atom.y,
  };
}

function domainHeaderBounds(domain: (typeof DOMAINS)[number]): GraphRect {
  return {
    height: 36,
    key: `${domain.key}-header`,
    width: Math.min(domain.width - 16, 190),
    x: domain.x + 8,
    y: domain.y - 14,
  };
}

function atomBoundsForLayout(atom: (typeof ATOMS)[number]): GraphRect {
  return {
    ...atomBounds(atom),
    x: atom.x,
    y: atom.y,
  };
}

function closeAtomPairs(atoms: typeof ATOMS): readonly string[] {
  const pairs: string[] = [];
  for (const [leftIndex, left] of atoms.entries()) {
    for (const right of atoms.slice(leftIndex + 1)) {
      if (left.domain !== right.domain) {
        continue;
      }
      const leftBounds = atomBoundsForLayout(left);
      const rightBounds = atomBoundsForLayout(right);
      const gapX = Math.max(
        0,
        rightBounds.x - (leftBounds.x + leftBounds.width),
        leftBounds.x - (rightBounds.x + rightBounds.width),
      );
      const gapY = Math.max(
        0,
        rightBounds.y - (leftBounds.y + leftBounds.height),
        leftBounds.y - (rightBounds.y + rightBounds.height),
      );
      if (Math.hypot(gapX, gapY) < 18) {
        pairs.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return pairs;
}

function overlappingAtoms(atoms: typeof ATOMS): readonly string[] {
  const overlaps: string[] = [];
  for (const [leftIndex, left] of atoms.entries()) {
    for (const right of atoms.slice(leftIndex + 1)) {
      const leftBounds = atomBoundsForLayout(left);
      const rightBounds = atomBoundsForLayout(right);
      if (
        leftBounds.x < rightBounds.x + rightBounds.width &&
        leftBounds.x + leftBounds.width > rightBounds.x &&
        leftBounds.y < rightBounds.y + rightBounds.height &&
        leftBounds.y + leftBounds.height > rightBounds.y
      ) {
        overlaps.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return overlaps;
}

function reusedPorts(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
  endpoint: "from" | "to",
): readonly string[] {
  const grouped = Map.groupBy(edges, (edge) => edge[endpoint]);
  return [...grouped].flatMap(([atomKey, atomEdges]) => {
    const points = atomEdges.map((edge) => (endpoint === "from" ? edge.startPoint : edge.endPoint));
    const unique = new Set(points.map((point) => `${point.x}:${point.y}`));
    return unique.size === points.length ? [] : [atomKey];
  });
}

function reciprocalEdges(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
): readonly string[] {
  const pairs = new Set(edges.map((edge) => `${edge.from}:${edge.to}`));
  return edges.flatMap((edge) =>
    edge.from < edge.to && pairs.has(`${edge.to}:${edge.from}`)
      ? [`${edge.from} <-> ${edge.to}`]
      : [],
  );
}

function sharedRouteSegments(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
): readonly string[] {
  const overlaps: string[] = [];
  for (const [leftIndex, left] of edges.entries()) {
    for (const right of edges.slice(leftIndex + 1)) {
      if (
        edgeSegments(left.points[0] ?? []).some((leftSegment) =>
          edgeSegments(right.points[0] ?? []).some(
            (rightSegment) => collinearOverlap(leftSegment, rightSegment) > 2,
          ),
        )
      ) {
        overlaps.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return overlaps;
}

function shortEndpointSegments(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
): readonly string[] {
  return edges.flatMap((edge) => {
    const points = edge.points[0] ?? [];
    const start = points[0];
    const afterStart = points[1];
    const end = points.at(-1);
    const beforeEnd = points.at(-2);
    if (
      start === undefined ||
      afterStart === undefined ||
      end === undefined ||
      beforeEnd === undefined
    ) {
      return [edge.key];
    }
    const startLength = Math.abs(start.x - afterStart.x) + Math.abs(start.y - afterStart.y);
    const endLength = Math.abs(end.x - beforeEnd.x) + Math.abs(end.y - beforeEnd.y);
    return startLength >= 18 && endLength >= 18 ? [] : [edge.key];
  });
}

function closeParallelRouteSegments(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
): readonly string[] {
  const close: string[] = [];
  for (const [leftIndex, left] of edges.entries()) {
    for (const right of edges.slice(leftIndex + 1)) {
      if (
        left.from === right.from ||
        left.from === right.to ||
        left.to === right.from ||
        left.to === right.to
      ) {
        continue;
      }
      if (
        edgeSegments(left.points[0] ?? []).some((leftSegment) =>
          edgeSegments(right.points[0] ?? []).some(
            (rightSegment) => parallelLaneDistance(leftSegment, rightSegment) < 16,
          ),
        )
      ) {
        close.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return close;
}

interface TestSegment {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

function edgeSegments(points: readonly TestSegment["from"][]): readonly TestSegment[] {
  return points.slice(1).flatMap((to, index) => {
    const from = points[index];
    return from === undefined ? [] : [{ from, to }];
  });
}

function collinearOverlap(left: TestSegment, right: TestSegment): number {
  const leftHorizontal = left.from.y === left.to.y;
  const rightHorizontal = right.from.y === right.to.y;
  if (leftHorizontal !== rightHorizontal) {
    return 0;
  }
  if (
    (leftHorizontal && left.from.y !== right.from.y) ||
    (!leftHorizontal && left.from.x !== right.from.x)
  ) {
    return 0;
  }
  const leftStart = leftHorizontal
    ? Math.min(left.from.x, left.to.x)
    : Math.min(left.from.y, left.to.y);
  const leftEnd = leftHorizontal
    ? Math.max(left.from.x, left.to.x)
    : Math.max(left.from.y, left.to.y);
  const rightStart = rightHorizontal
    ? Math.min(right.from.x, right.to.x)
    : Math.min(right.from.y, right.to.y);
  const rightEnd = rightHorizontal
    ? Math.max(right.from.x, right.to.x)
    : Math.max(right.from.y, right.to.y);
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function parallelLaneDistance(left: TestSegment, right: TestSegment): number {
  const leftHorizontal = left.from.y === left.to.y;
  const rightHorizontal = right.from.y === right.to.y;
  if (leftHorizontal !== rightHorizontal) {
    return Number.POSITIVE_INFINITY;
  }
  const distance = leftHorizontal
    ? Math.abs(left.from.y - right.from.y)
    : Math.abs(left.from.x - right.from.x);
  if (distance === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const leftStart = leftHorizontal
    ? Math.min(left.from.x, left.to.x)
    : Math.min(left.from.y, left.to.y);
  const leftEnd = leftHorizontal
    ? Math.max(left.from.x, left.to.x)
    : Math.max(left.from.y, left.to.y);
  const rightStart = rightHorizontal
    ? Math.min(right.from.x, right.to.x)
    : Math.min(right.from.y, right.to.y);
  const rightEnd = rightHorizontal
    ? Math.max(right.from.x, right.to.x)
    : Math.max(right.from.y, right.to.y);
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  return overlap > 40 ? distance : Number.POSITIVE_INFINITY;
}

function crossingRoutes(
  edges: Awaited<ReturnType<FlowLayoutEngine["layout"]>>["edges"],
): readonly string[] {
  const crossings: string[] = [];
  for (const [leftIndex, left] of edges.entries()) {
    for (const right of edges.slice(leftIndex + 1)) {
      if (
        left.from === right.from ||
        left.from === right.to ||
        left.to === right.from ||
        left.to === right.to
      ) {
        continue;
      }
      if (
        edgeSegments(left.points[0] ?? []).some((leftSegment) =>
          edgeSegments(right.points[0] ?? []).some((rightSegment) =>
            segmentsCross(leftSegment, rightSegment),
          ),
        )
      ) {
        crossings.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return crossings;
}

function segmentsCross(left: TestSegment, right: TestSegment): boolean {
  const leftHorizontal = left.from.y === left.to.y;
  const rightHorizontal = right.from.y === right.to.y;
  if (leftHorizontal === rightHorizontal) {
    return false;
  }
  const horizontal = leftHorizontal ? left : right;
  const vertical = leftHorizontal ? right : left;
  const crossingX = vertical.from.x;
  const crossingY = horizontal.from.y;
  return (
    crossingX > Math.min(horizontal.from.x, horizontal.to.x) &&
    crossingX < Math.max(horizontal.from.x, horizontal.to.x) &&
    crossingY > Math.min(vertical.from.y, vertical.to.y) &&
    crossingY < Math.max(vertical.from.y, vertical.to.y)
  );
}
