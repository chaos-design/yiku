import type { AtomicDefinition } from "@yiku/atomic-flow/browser";
import { describe, expect, it } from "vitest";
import {
  ATOM_NODE_HEIGHT,
  ATOM_NODE_MIN_WIDTH,
  ATOMS,
  atomNodeWidth,
  DOMAINS,
  domainLayoutsForAtoms,
  dynamicAtomLayouts,
  dynamicEdges,
  EDGES,
  edgeLayoutKey,
  edgeRouteKey,
  MEMORY_ATOM_MIN_WIDTH,
  SYSTEM_ATOM_DEFINITIONS,
} from "../../src/data/atom-layout.js";

describe("atom focus", () => {
  it("derives a stable width that keeps atom titles on one line", () => {
    expect(atomNodeWidth("Run")).toBe(ATOM_NODE_MIN_WIDTH);
    expect(atomNodeWidth("Trajectory Project")).toBeGreaterThan(ATOM_NODE_MIN_WIDTH);
    expect(atomNodeWidth("自定义超长原子标题")).toBeGreaterThan(ATOM_NODE_MIN_WIDTH);
    expect(ATOMS.every((atom) => atom.width >= atomNodeWidth(atom.label))).toBe(true);
  });

  it("uses the full memory domain with readable retrieval spacing", () => {
    const memoryDomain = DOMAINS.find((domain) => domain.key === "memory");
    const memoryAtoms = ATOMS.filter((atom) => atom.domain === "memory");
    const memoryByKey = new Map(memoryAtoms.map((atom) => [atom.key, atom]));
    const recall = requiredAtom(memoryByKey, "memory.recall");
    const search = requiredAtom(memoryByKey, "memory.search");
    const queryEmbedding = requiredAtom(memoryByKey, "memory.query-embedding");
    const ftsSearch = requiredAtom(memoryByKey, "memory.fts-search");
    const vectorSearch = requiredAtom(memoryByKey, "memory.vector-search");
    const rerank = requiredAtom(memoryByKey, "memory.rerank");
    const contextInject = requiredAtom(memoryByKey, "memory.context-inject");
    const extract = requiredAtom(memoryByKey, "memory.extract");
    const write = requiredAtom(memoryByKey, "memory.write");

    expect(memoryAtoms.every((atom) => atom.width >= MEMORY_ATOM_MIN_WIDTH)).toBe(true);
    expect(horizontalGap(recall, search)).toBeGreaterThanOrEqual(30);
    expect(horizontalGap(search, queryEmbedding)).toBeGreaterThanOrEqual(30);
    expect(horizontalGap(queryEmbedding, ftsSearch)).toBeGreaterThanOrEqual(80);
    expect(verticalGap(ftsSearch, vectorSearch)).toBeGreaterThanOrEqual(32);
    expect(verticalGap(vectorSearch, rerank)).toBeGreaterThanOrEqual(28);
    expect(contextInject.x).toBe(extract.x);
    expect(extract.x).toBe(write.x);
    expect(
      Math.max(...memoryAtoms.map((atom) => atom.x + atom.width)) - (memoryDomain?.x ?? 0),
    ).toBeGreaterThanOrEqual((memoryDomain?.width ?? Number.POSITIVE_INFINITY) * 0.85);
  });

  it("keeps User Question beside its Tool Call producer", () => {
    const userQuestion = ATOMS.find((atom) => atom.key === "user.question");
    const toolCall = ATOMS.find((atom) => atom.key === "tool.call");

    expect(userQuestion).toMatchObject({ domain: "execution", focus: "user" });
    expect((userQuestion?.y ?? 0) - ((toolCall?.y ?? 0) + ATOM_NODE_HEIGHT)).toBeGreaterThanOrEqual(
      18,
    );
    expect(
      dynamicAtomLayouts([
        {
          key: "user.question",
          kind: "input",
          label: "User Question",
          level: "runtime",
        },
      ]),
    ).toEqual([]);
  });

  it("classifies user and test concerns by domain", () => {
    const testDomains = new Set(["quality", "telemetry"]);

    expect(
      ATOMS.every((atom) => atom.focus === (testDomains.has(atom.domain) ? "test" : "user")),
    ).toBe(true);
  });

  it("defines the six professional observability domains", () => {
    expect(DOMAINS.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: "session", label: "01 · SESSION CONTROL" },
      { key: "execution", label: "02 · AGENT EXECUTION" },
      { key: "memory", label: "03 · MEMORY SYSTEMS" },
      { key: "capabilities", label: "04 · CAPABILITY ORCHESTRATION" },
      { key: "telemetry", label: "05 · TELEMETRY" },
      { key: "quality", label: "06 · QUALITY GATES" },
    ]);
    expect(DOMAINS.find((domain) => domain.key === "session")?.height).toBeGreaterThanOrEqual(900);
  });

  it("keeps every capability atom in the fixed capability domain", () => {
    expect(
      ATOMS.filter((atom) => atom.key.startsWith("skill.") || atom.key.startsWith("agent.")).map(
        ({ domain, key }) => ({ domain, key }),
      ),
    ).toEqual([
      { domain: "execution", key: "agent.select" },
      { domain: "capabilities", key: "skill.resolve" },
      { domain: "capabilities", key: "skill.activate" },
      { domain: "capabilities", key: "skill.execute" },
      { domain: "capabilities", key: "agent.profile" },
      { domain: "capabilities", key: "agent.spawn" },
      { domain: "capabilities", key: "agent.execute" },
      { domain: "capabilities", key: "agent.result" },
    ]);
    expect(
      dynamicAtomLayouts(SYSTEM_ATOM_DEFINITIONS).map(({ domain, key }) => ({
        domain,
        key,
      })),
    ).toEqual([
      {
        domain: "telemetry",
        key: "observability.degraded",
      },
      {
        domain: "session",
        key: "runtime.boundary",
      },
    ]);
  });

  it("keeps fixed routes aligned with emitted runtime edges", () => {
    const routes = new Set(EDGES.map(edgeRouteKey));

    expect([...routes]).toEqual(
      expect.arrayContaining([
        "eval.trigger:eval.scorecard:data",
        "hook.dispatch:input.prompt:execution",
        "hook.execute:input.prompt:execution",
        "input.prompt:memory.working-capture:feedback",
        "input.prompt:run:execution",
        "memory.extract:memory.working-capture:feedback",
        "run:stage.finish:execution",
        "stage.finish:context.compact:execution",
        "stage.start:input.prompt:execution",
        "stage.start:task.snapshot:execution",
        "subagent.lifecycle:agent.spawn:execution",
        "task.snapshot:subagent.lifecycle:execution",
        "tool.call:user.question:execution",
      ]),
    );
    expect(routes.has("input.prompt:user.question:execution")).toBe(false);
    expect(routes.has("user.question:run:execution")).toBe(false);
    expect(routes.has("session.checkpoint:stage.finish:execution")).toBe(false);
    expect(routes.has("context.compact:run:data")).toBe(false);
    expect(new Set(EDGES.map(edgeRouteKey)).size).toBe(EDGES.length);
    const atomKeys = new Set(ATOMS.map((atom) => atom.key));
    expect(EDGES.every((edge) => atomKeys.has(edge.from) && atomKeys.has(edge.to))).toBe(true);
  });

  it("classifies dynamically discovered atoms", () => {
    const definitions: readonly AtomicDefinition[] = [
      {
        key: "tool.custom",
        kind: "tool",
        label: "Custom Tool",
        level: "runtime",
      },
      {
        key: "eval.custom",
        kind: "eval",
        label: "Custom Eval",
        level: "runtime",
      },
    ];

    expect(
      dynamicAtomLayouts(definitions).map(({ focus, key }) => ({
        focus,
        key,
      })),
    ).toEqual([
      { focus: "test", key: "eval.custom" },
      { focus: "user", key: "tool.custom" },
    ]);
  });

  it("keeps optional quality lifecycle atoms and custom evaluators in clear lanes", () => {
    const layouts = dynamicAtomLayouts([
      {
        key: "eval.attempt",
        kind: "eval",
        label: "Eval Attempt",
        level: "runtime",
      },
      {
        key: "eval.decision",
        kind: "release",
        label: "Eval Decision",
        level: "runtime",
      },
      {
        key: "eval.repair",
        kind: "eval",
        label: "Eval Repair",
        level: "runtime",
      },
      ...[
        "Code Artifact Integrity",
        "Code Change Scope",
        "Code Verification Command",
        "Final Output Completeness",
        "Performance Budget",
        "Resource Budget Compliance",
      ].map((label, index) => ({
        key: `eval.custom-${index}`,
        kind: "eval" as const,
        label,
        level: "runtime" as const,
      })),
    ]);
    const qualityAtoms = [
      ...ATOMS.filter((atom) => atom.domain === "quality"),
      ...layouts.filter((atom) => atom.domain === "quality"),
    ];
    const qualityDomain = DOMAINS.find((domain) => domain.key === "quality");

    expect(layouts.find((atom) => atom.key === "eval.attempt")).toMatchObject({
      x: 1454,
      y: 336,
    });
    expect(layouts.find((atom) => atom.key === "eval.decision")).toMatchObject({
      x: 1650,
      y: 536,
    });
    expect(layouts.find((atom) => atom.key === "eval.repair")).toMatchObject({
      x: 1840,
      y: 626,
    });
    expect(atomClearanceViolations(qualityAtoms, 18)).toEqual([]);
    expect(
      qualityAtoms.every(
        (atom) =>
          atom.x >= (qualityDomain?.x ?? 0) &&
          atom.x + atom.width <= (qualityDomain?.x ?? 0) + (qualityDomain?.width ?? 0) &&
          atom.y >= (qualityDomain?.y ?? 0) &&
          atom.y + ATOM_NODE_HEIGHT <= (qualityDomain?.y ?? 0) + (qualityDomain?.height ?? 0),
      ),
    ).toBe(true);
  });

  it("groups unknown Agent namespaces into deterministic dynamic domains", () => {
    const layouts = dynamicAtomLayouts([
      {
        key: "research.search",
        kind: "tool",
        label: "Search",
        level: "runtime",
      },
      {
        key: "research.plan",
        kind: "context",
        label: "Plan",
        level: "runtime",
      },
    ]);
    const domains = domainLayoutsForAtoms([...ATOMS, ...layouts]);

    expect(layouts.map(({ domain, key }) => ({ domain, key }))).toEqual([
      { domain: "agent:research", key: "research.plan" },
      { domain: "agent:research", key: "research.search" },
    ]);
    expect(domains.at(-1)).toMatchObject({
      key: "agent:research",
      label: "07 · RESEARCH DOMAIN",
      subtitle: "research agent semantics",
    });
    expect(layouts[0]?.x).toBeLessThan(layouts[1]?.x ?? 0);
  });

  it("maps every dynamic kind and leaves dynamic routes to observed event edges", () => {
    const kinds: readonly AtomicDefinition["kind"][] = [
      "release",
      "memory",
      "trace",
      "trajectory",
      "input",
      "context",
      "hook",
      "store",
      "model",
      "skill",
      "agent",
    ];
    const definitions = kinds.map((kind, index) => ({
      key: `${kind}.custom-${index}`,
      kind,
      label: kind,
      level: "runtime" as const,
    }));
    const layouts = dynamicAtomLayouts(definitions);

    expect(layouts.map((atom) => atom.domain)).toEqual([
      "capabilities",
      "session",
      "session",
      "session",
      "memory",
      "execution",
      "quality",
      "capabilities",
      "session",
      "telemetry",
      "telemetry",
    ]);
    const edges = dynamicEdges(definitions);
    expect(edges).toEqual([]);
  });

  it("keeps runtime edge identity stable while including offsets in the layout key", () => {
    const edge = {
      from: "source",
      fromSide: "right",
      fromSlot: 0.5,
      kind: "data",
      segmentOffsets: { 4: -8, 2: 12 },
      to: "target",
      toSide: "left",
      toSlot: 0.25,
    } as const;

    expect(edgeRouteKey(edge)).toBe("source:target:data");
    expect(edgeLayoutKey(edge)).toBe("source:target:data:right:0.5:left:0.25:2:12,4:-8");
    expect(
      edgeLayoutKey({
        ...edge,
        segmentOffsets: { 2: 12, 4: -8 },
      }),
    ).toBe(edgeLayoutKey(edge));
  });
});

function requiredAtom(
  atoms: ReadonlyMap<string, (typeof ATOMS)[number]>,
  key: string,
): (typeof ATOMS)[number] {
  const atom = atoms.get(key);
  if (atom === undefined) {
    throw new Error(`Expected fixed atom: ${key}`);
  }
  return atom;
}

function horizontalGap(left: (typeof ATOMS)[number], right: (typeof ATOMS)[number]): number {
  return right.x - (left.x + left.width);
}

function verticalGap(top: (typeof ATOMS)[number], bottom: (typeof ATOMS)[number]): number {
  return bottom.y - (top.y + ATOM_NODE_HEIGHT);
}

function atomClearanceViolations(atoms: readonly (typeof ATOMS)[number][], clearance: number) {
  const violations: string[] = [];
  for (const [leftIndex, left] of atoms.entries()) {
    for (const right of atoms.slice(leftIndex + 1)) {
      const gapX = Math.max(0, right.x - (left.x + left.width), left.x - (right.x + right.width));
      const gapY = Math.max(
        0,
        right.y - (left.y + ATOM_NODE_HEIGHT),
        left.y - (right.y + ATOM_NODE_HEIGHT),
      );
      if (Math.hypot(gapX, gapY) < clearance) {
        violations.push(`${left.key} <> ${right.key}`);
      }
    }
  }
  return violations;
}
