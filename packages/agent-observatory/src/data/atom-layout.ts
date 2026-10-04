import {
  CAPABILITY_ATOMS,
  HOOK_ATOMS,
  RUNTIME_ATOM_DEFINITIONS,
  RUNTIME_ATOMS,
} from "@yiku/agent-orchestrator/atoms";
import {
  type AtomicDefinition,
  type AtomicKind,
  type AtomicLevel,
  FLOW_ATOM_DEFINITIONS,
  FLOW_ATOMS,
} from "@yiku/atomic-flow/browser";
import { EVAL_ATOM_DEFINITIONS, EVAL_ATOMS } from "@yiku/evals/atoms";
import type { GraphRect, SegmentOffsets } from "@yiku/flow-graph";
import { MEMORY_ATOM_DEFINITIONS, MEMORY_ATOMS } from "@yiku/memories/atoms";
import { TRAJECTORY_ATOM_DEFINITIONS, TRAJECTORY_ATOMS } from "@yiku/trajectory/atoms";

export type SystemDomainKey =
  | "capabilities"
  | "execution"
  | "memory"
  | "quality"
  | "session"
  | "telemetry";
export type DomainKey = SystemDomainKey | `agent:${string}`;
export type AtomFocus = "test" | "user";

export const ATOM_NODE_HEIGHT = 50;
export const ATOM_NODE_MIN_WIDTH = 106;
export const MEMORY_ATOM_MIN_WIDTH = 132;
const SKILL_ATOM_MIN_WIDTH = 132;
const DYNAMIC_DOMAIN_GAP = 24;
const DYNAMIC_DOMAIN_WIDTH = 520;
const DYNAMIC_DOMAIN_X = 2_053;
const QUALITY_COLUMNS = [1_454, 1_650, 1_840] as const;
const QUALITY_DYNAMIC_EVALUATOR_SLOTS = [
  { x: QUALITY_COLUMNS[1], y: 246 },
  { x: QUALITY_COLUMNS[2], y: 246 },
  { x: QUALITY_COLUMNS[1], y: 336 },
  { x: QUALITY_COLUMNS[2], y: 336 },
  { x: QUALITY_COLUMNS[1], y: 426 },
  { x: QUALITY_COLUMNS[2], y: 426 },
] as const;
const RESERVED_NAMESPACES = new Set([
  "action",
  "agent",
  "context",
  "eval",
  "flow",
  "handoff",
  "hook",
  "input",
  "loop",
  "memory",
  "model",
  "observation",
  "observability",
  "release",
  "reply",
  "run",
  "session",
  "skill",
  "stage",
  "store",
  "subagent",
  "task",
  "tool",
  "trace",
  "trajectory",
  "usage",
  "user",
]);
const DYNAMIC_EVAL_ATOM_KEYS: ReadonlySet<string> = new Set([
  EVAL_ATOMS.attempt.key,
  EVAL_ATOMS.decision.key,
  EVAL_ATOMS.repair.key,
]);
const DYNAMIC_EVAL_ATOM_POSITIONS: ReadonlyMap<string, { readonly x: number; readonly y: number }> =
  new Map([
    [EVAL_ATOMS.attempt.key, { x: QUALITY_COLUMNS[0], y: 336 }],
    [EVAL_ATOMS.decision.key, { x: QUALITY_COLUMNS[1], y: 536 }],
    [EVAL_ATOMS.repair.key, { x: QUALITY_COLUMNS[2], y: 626 }],
  ]);
const DYNAMIC_SYSTEM_ATOM_POSITIONS: ReadonlyMap<
  string,
  { readonly domain: SystemDomainKey; readonly x: number; readonly y: number }
> = new Map([[RUNTIME_ATOMS.runtimeBoundary.key, { domain: "session", x: 125, y: 556 }]]);

export interface AtomLayout {
  readonly domain: DomainKey;
  readonly focus: AtomFocus;
  readonly key: string;
  readonly kind: AtomicKind;
  readonly label: string;
  readonly level: AtomicLevel;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface DomainLayout {
  readonly height: number;
  readonly key: DomainKey;
  readonly label: string;
  readonly subtitle: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export type PortSide = "bottom" | "left" | "right" | "top";

export interface EdgeLayout {
  readonly from: string;
  readonly fromMode?: "fixed" | "preferred" | undefined;
  readonly fromSide?: PortSide | undefined;
  readonly fromSlot?: number | undefined;
  readonly kind: "data" | "execution" | "feedback" | "persistence";
  readonly routeBounds?: GraphRect | undefined;
  readonly segmentOffsets?: SegmentOffsets | undefined;
  readonly to: string;
  readonly toMode?: "fixed" | "preferred" | undefined;
  readonly toSide?: PortSide | undefined;
  readonly toSlot?: number | undefined;
}

export const DOMAINS: readonly DomainLayout[] = [
  {
    height: 930,
    key: "session",
    label: "01 · SESSION CONTROL",
    subtitle: "request · lifecycle · hooks",
    width: 300,
    x: 15,
    y: 16,
  },
  {
    height: 390,
    key: "execution",
    label: "02 · AGENT EXECUTION",
    subtitle: "turn-scoped execution",
    width: 640,
    x: 340,
    y: 16,
  },
  {
    height: 700,
    key: "memory",
    label: "03 · MEMORY SYSTEMS",
    subtitle: "recall · classify · inject · write",
    width: 1059,
    x: 340,
    y: 484,
  },
  {
    height: 430,
    key: "capabilities",
    label: "04 · CAPABILITY ORCHESTRATION",
    subtitle: "skills · profiles · subagents",
    width: 394,
    x: 1005,
    y: 16,
  },
  {
    height: 464,
    key: "telemetry",
    label: "05 · TELEMETRY",
    subtitle: "persist · project · diagnose",
    width: 394,
    x: 1424,
    y: 720,
  },
  {
    height: 680,
    key: "quality",
    label: "06 · QUALITY GATES",
    subtitle: "evaluate · score · gate",
    width: 604,
    x: 1424,
    y: 16,
  },
];

export const SYSTEM_ATOM_DEFINITIONS: readonly AtomicDefinition[] = Object.freeze([
  ...RUNTIME_ATOM_DEFINITIONS,
  ...MEMORY_ATOM_DEFINITIONS,
  ...FLOW_ATOM_DEFINITIONS,
  ...TRAJECTORY_ATOM_DEFINITIONS,
  ...EVAL_ATOM_DEFINITIONS.filter((definition) => !DYNAMIC_EVAL_ATOM_KEYS.has(definition.key)),
]);

export const ATOMS: readonly AtomLayout[] = [
  at(RUNTIME_ATOMS.inputPrompt, "session", 35, 56),
  at(RUNTIME_ATOMS.sessionResume, "session", 65, 141),
  at(RUNTIME_ATOMS.stageStart, "session", 65, 226),
  at(RUNTIME_ATOMS.sessionCheckpoint, "session", 65, 311),
  at(RUNTIME_ATOMS.stageFinish, "session", 65, 396),
  at(RUNTIME_ATOMS.contextCompact, "session", 90, 481),
  at(RUNTIME_ATOMS.taskSnapshot, "session", 125, 626),
  at(HOOK_ATOMS.dispatch, "session", 35, 736),
  at(HOOK_ATOMS.execute, "session", 170, 736),

  at(RUNTIME_ATOMS.run, "execution", 370, 56),
  at(RUNTIME_ATOMS.loopTurn, "execution", 430, 146),
  at(RUNTIME_ATOMS.observation, "execution", 370, 236),
  at(RUNTIME_ATOMS.agentSelect, "execution", 565, 56),
  at(RUNTIME_ATOMS.usageRecord, "execution", 850, 236),
  at(RUNTIME_ATOMS.toolCall, "execution", 565, 236),
  at(RUNTIME_ATOMS.handoff, "execution", 370, 326),
  at(RUNTIME_ATOMS.modelInvoke, "execution", 760, 56),
  at(RUNTIME_ATOMS.actionGate, "execution", 760, 146),
  at(RUNTIME_ATOMS.userQuestion, "execution", 565, 326),
  at(RUNTIME_ATOMS.replyFinal, "execution", 760, 326),

  at(MEMORY_ATOMS.recall, "memory", 370, 534),
  at(MEMORY_ATOMS.search, "memory", 540, 534),
  at(MEMORY_ATOMS.queryEmbedding, "memory", 710, 534),
  at(MEMORY_ATOMS.ftsSearch, "memory", 930, 504),
  at(MEMORY_ATOMS.vectorSearch, "memory", 930, 604),
  at(MEMORY_ATOMS.rerank, "memory", 880, 704),
  at(MEMORY_ATOMS.scenario, "memory", 410, 684),
  at(MEMORY_ATOMS.procedure, "memory", 600, 714),
  at(MEMORY_ATOMS.semantic, "memory", 790, 794),
  at(MEMORY_ATOMS.contextInject, "memory", 1230, 754),
  at(MEMORY_ATOMS.workingCapture, "memory", 370, 874),
  at(MEMORY_ATOMS.working, "memory", 550, 874),
  at(MEMORY_ATOMS.extract, "memory", 1230, 964),
  at(MEMORY_ATOMS.consolidate, "memory", 720, 984),
  at(MEMORY_ATOMS.write, "memory", 1230, 1084),
  at(MEMORY_ATOMS.forget, "memory", 370, 1004),
  at(MEMORY_ATOMS.prune, "memory", 550, 1074),

  at(CAPABILITY_ATOMS.skillResolve, "capabilities", 1035, 66),
  at(CAPABILITY_ATOMS.skillActivate, "capabilities", 1220, 66),
  at(CAPABILITY_ATOMS.skillExecute, "capabilities", 1220, 156),
  at(CAPABILITY_ATOMS.agentProfile, "capabilities", 1035, 261),
  at(CAPABILITY_ATOMS.agentSpawn, "capabilities", 1220, 261),
  at(CAPABILITY_ATOMS.agentExecute, "capabilities", 1220, 356),
  at(CAPABILITY_ATOMS.agentResult, "capabilities", 1035, 356),
  at(RUNTIME_ATOMS.subagentLifecycle, "capabilities", 1035, 166),

  at(FLOW_ATOMS.traceAppend, "telemetry", 1454, 770),
  at(TRAJECTORY_ATOMS.project, "telemetry", 1639, 890),
  at(FLOW_ATOMS.sinkError, "telemetry", 1454, 1040),

  at(EVAL_ATOMS.trigger, "quality", QUALITY_COLUMNS[0], 246),
  at(EVAL_ATOMS.flowIntegrity, "quality", QUALITY_COLUMNS[1], 66),
  at(EVAL_ATOMS.finalOutput, "quality", QUALITY_COLUMNS[2], 66),
  at(EVAL_ATOMS.memorySafety, "quality", QUALITY_COLUMNS[1], 156),
  at(EVAL_ATOMS.judge, "quality", QUALITY_COLUMNS[2], 156),
  at(EVAL_ATOMS.scorecard, "quality", QUALITY_COLUMNS[0], 536),
  at(EVAL_ATOMS.gate, "quality", QUALITY_COLUMNS[2], 536),
];

export const EDGES: readonly EdgeLayout[] = [
  edge(HOOK_ATOMS.dispatch, RUNTIME_ATOMS.inputPrompt, "execution", {
    fromSide: "top",
    fromSlot: 0.35,
    toSide: "bottom",
    toSlot: 0.35,
  }),
  edge(HOOK_ATOMS.execute, RUNTIME_ATOMS.inputPrompt, "execution", {
    fromSide: "top",
    fromSlot: 0.65,
    toSide: "bottom",
    toSlot: 0.65,
  }),
  edge(RUNTIME_ATOMS.stageStart, RUNTIME_ATOMS.inputPrompt, "execution", {
    fromSide: "right",
    fromSlot: 0.25,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.inputPrompt, MEMORY_ATOMS.recall, "data", {
    fromSide: "left",
    fromSlot: 0.7,
    toSide: "left",
  }),
  edge(RUNTIME_ATOMS.inputPrompt, RUNTIME_ATOMS.run, "execution", {
    fromSide: "top",
    fromSlot: 0.5,
    toSide: "left",
    toSlot: 0.25,
  }),
  edge(RUNTIME_ATOMS.toolCall, RUNTIME_ATOMS.userQuestion, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.inputPrompt, MEMORY_ATOMS.workingCapture, "feedback", {
    fromSide: "bottom",
    fromSlot: 0.1,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.recall, MEMORY_ATOMS.search, "execution", {
    fromSide: "right",
    toSide: "left",
  }),
  edge(MEMORY_ATOMS.search, MEMORY_ATOMS.queryEmbedding, "execution", {
    fromSide: "right",
    toSide: "left",
  }),
  edge(MEMORY_ATOMS.queryEmbedding, MEMORY_ATOMS.ftsSearch),
  edge(MEMORY_ATOMS.queryEmbedding, MEMORY_ATOMS.vectorSearch),
  edge(MEMORY_ATOMS.vectorSearch, MEMORY_ATOMS.rerank, "data"),
  edge(MEMORY_ATOMS.rerank, MEMORY_ATOMS.scenario, "data"),
  edge(MEMORY_ATOMS.rerank, MEMORY_ATOMS.procedure, "data", {
    fromSide: "left",
    fromSlot: 0.5,
    toSide: "right",
    toSlot: 0.3,
  }),
  edge(MEMORY_ATOMS.rerank, MEMORY_ATOMS.semantic, "data", {
    fromSide: "bottom",
    fromSlot: 0.8,
    toSide: "top",
    toSlot: 0.7,
  }),
  edge(MEMORY_ATOMS.working, MEMORY_ATOMS.contextInject, "data", {
    fromSide: "top",
    fromSlot: 0.5,
    toSide: "bottom",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.scenario, MEMORY_ATOMS.contextInject, "data", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "left",
    toSlot: 0.2,
  }),
  edge(MEMORY_ATOMS.procedure, MEMORY_ATOMS.contextInject, "data", {
    fromSide: "bottom",
    fromSlot: 0.8,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.semantic, MEMORY_ATOMS.contextInject, "data", {
    fromSide: "right",
    fromSlot: 0.7,
    toSide: "left",
    toSlot: 0.8,
  }),
  edge(MEMORY_ATOMS.contextInject, RUNTIME_ATOMS.run, "data", {
    fromSide: "top",
    fromSlot: 0.5,
    toSide: "bottom",
    toSlot: 0.75,
  }),
  edge(RUNTIME_ATOMS.run, RUNTIME_ATOMS.loopTurn, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.loopTurn, RUNTIME_ATOMS.agentSelect),
  edge(RUNTIME_ATOMS.agentSelect, RUNTIME_ATOMS.modelInvoke),
  edge(RUNTIME_ATOMS.modelInvoke, RUNTIME_ATOMS.actionGate),
  edge(RUNTIME_ATOMS.modelInvoke, RUNTIME_ATOMS.usageRecord, "data"),
  edge(RUNTIME_ATOMS.actionGate, RUNTIME_ATOMS.toolCall, "execution", {
    fromSide: "left",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.toolCall, RUNTIME_ATOMS.observation),
  edge(CAPABILITY_ATOMS.skillResolve, CAPABILITY_ATOMS.skillActivate),
  edge(CAPABILITY_ATOMS.skillActivate, CAPABILITY_ATOMS.skillExecute),
  edge(RUNTIME_ATOMS.observation, RUNTIME_ATOMS.loopTurn, "feedback", {
    toSide: "bottom",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.actionGate, RUNTIME_ATOMS.handoff, "execution", {
    fromSide: "bottom",
    fromSlot: 0.3,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.actionGate, RUNTIME_ATOMS.replyFinal, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.replyFinal, MEMORY_ATOMS.extract, "feedback", {
    fromMode: "fixed",
    fromSide: "bottom",
    fromSlot: 0.72,
    routeBounds: {
      height: 1168,
      width: 1059,
      x: 340,
      y: 16,
    },
    toMode: "fixed",
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.workingCapture, MEMORY_ATOMS.working, "data", {
    fromSide: "right",
    fromSlot: 0.3,
    toSide: "left",
    toSlot: 0.8,
  }),
  edge(MEMORY_ATOMS.extract, MEMORY_ATOMS.workingCapture, "feedback", {
    fromSide: "right",
    fromSlot: 0.6,
    toSide: "bottom",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.working, MEMORY_ATOMS.consolidate, "execution", {
    fromSide: "left",
    toSide: "right",
  }),
  edge(MEMORY_ATOMS.consolidate, MEMORY_ATOMS.scenario, "data", {
    fromSide: "top",
    fromSlot: 0.1,
    toSide: "bottom",
    toSlot: 0.3,
  }),
  edge(MEMORY_ATOMS.consolidate, MEMORY_ATOMS.procedure, "data", {
    fromSide: "top",
    fromSlot: 0.1,
    toSide: "bottom",
    toSlot: 0.3,
  }),
  edge(MEMORY_ATOMS.consolidate, MEMORY_ATOMS.semantic, "data", {
    fromSide: "top",
    fromSlot: 0.65,
    toSide: "bottom",
    toSlot: 0.5,
  }),
  edge(MEMORY_ATOMS.consolidate, MEMORY_ATOMS.write),
  edge(MEMORY_ATOMS.extract, MEMORY_ATOMS.write),
  edge(RUNTIME_ATOMS.sessionResume, RUNTIME_ATOMS.stageStart, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.stageStart, RUNTIME_ATOMS.sessionCheckpoint, "persistence", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.stageStart, RUNTIME_ATOMS.taskSnapshot, "execution", {
    fromSide: "bottom",
    fromSlot: 0.75,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.run, RUNTIME_ATOMS.stageFinish, "execution", {
    fromSide: "left",
    fromSlot: 0.25,
    toSide: "right",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.stageFinish, RUNTIME_ATOMS.contextCompact, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(RUNTIME_ATOMS.taskSnapshot, RUNTIME_ATOMS.subagentLifecycle, "execution", {
    fromSide: "right",
    toSide: "left",
  }),
  edge(RUNTIME_ATOMS.taskSnapshot, CAPABILITY_ATOMS.agentProfile, "data", {
    fromSide: "right",
    fromSlot: 0.75,
    toSide: "left",
    toSlot: 0.3,
  }),
  edge(RUNTIME_ATOMS.subagentLifecycle, CAPABILITY_ATOMS.agentSpawn),
  edge(CAPABILITY_ATOMS.agentProfile, CAPABILITY_ATOMS.agentSpawn),
  edge(CAPABILITY_ATOMS.agentSpawn, CAPABILITY_ATOMS.agentExecute),
  edge(CAPABILITY_ATOMS.agentExecute, CAPABILITY_ATOMS.agentResult),
  edge(RUNTIME_ATOMS.run, FLOW_ATOMS.traceAppend, "persistence", {
    fromSide: "top",
    fromSlot: 0.5,
    toSide: "left",
  }),
  edge(FLOW_ATOMS.traceAppend, TRAJECTORY_ATOMS.project, "persistence"),
  edge(RUNTIME_ATOMS.replyFinal, EVAL_ATOMS.trigger, "feedback", {
    fromSide: "right",
    fromSlot: 0.3,
    toSide: "left",
  }),
  edge(EVAL_ATOMS.trigger, EVAL_ATOMS.flowIntegrity, "execution", {
    fromSide: "right",
    fromSlot: 0.5,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(EVAL_ATOMS.trigger, EVAL_ATOMS.finalOutput, "execution", {
    fromSide: "right",
    fromSlot: 0.3,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(EVAL_ATOMS.trigger, EVAL_ATOMS.memorySafety, "execution", {
    fromSide: "right",
    fromSlot: 0.7,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(EVAL_ATOMS.trigger, EVAL_ATOMS.judge, "execution", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "left",
    toSlot: 0.5,
  }),
  edge(EVAL_ATOMS.trigger, EVAL_ATOMS.scorecard, "data", {
    fromSide: "bottom",
    fromSlot: 0.5,
    toSide: "top",
    toSlot: 0.5,
  }),
  edge(EVAL_ATOMS.scorecard, EVAL_ATOMS.gate),
];

export function dynamicAtomLayouts(
  definitions: readonly AtomicDefinition[],
): readonly AtomLayout[] {
  const known = new Set(ATOMS.map((atom) => atom.key));
  const counters = new Map<DomainKey, number>();
  const domains = new Map(
    domainLayoutsForDefinitions(definitions).map((domain) => [domain.key, domain]),
  );
  return definitions
    .filter((definition) => !known.has(definition.key))
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((definition) => {
      const systemPosition = DYNAMIC_SYSTEM_ATOM_POSITIONS.get(definition.key);
      const domain = systemPosition?.domain ?? domainForDefinition(definition);
      if (systemPosition !== undefined) {
        return at(definition, domain, systemPosition.x, systemPosition.y);
      }
      const fixedPosition = DYNAMIC_EVAL_ATOM_POSITIONS.get(definition.key);
      if (fixedPosition !== undefined) {
        return at(definition, domain, fixedPosition.x, fixedPosition.y);
      }
      const index = counters.get(domain) ?? 0;
      counters.set(domain, index + 1);
      const zone = domains.get(domain);
      if (zone === undefined) {
        throw new Error(`Missing layout for Atomic domain: ${domain}.`);
      }
      const width = atomLayoutWidth(definition, domain);
      if (isAgentDomain(domain)) {
        const columnWidth = (zone.width - 64) / 2;
        const column = index % 2;
        const row = Math.floor(index / 2);
        return at(
          definition,
          domain,
          zone.x + 20 + column * (columnWidth + 24),
          zone.y + 60 + row * 78,
        );
      }
      if (domain === "quality") {
        const slot = QUALITY_DYNAMIC_EVALUATOR_SLOTS[index];
        if (slot !== undefined) {
          return at(definition, domain, slot.x, slot.y);
        }
        const overflowIndex = index - QUALITY_DYNAMIC_EVALUATOR_SLOTS.length;
        return at(
          definition,
          domain,
          QUALITY_COLUMNS[1 + (overflowIndex % 2)] ?? QUALITY_COLUMNS[1],
          716 + Math.floor(overflowIndex / 2) * 90,
        );
      }
      return at(
        definition,
        domain,
        zone.x + zone.width - width - 20,
        zone.y + 40 + (index % 5) * 68,
      );
    });
}

export function domainLayoutsForAtoms(atoms: readonly AtomLayout[]): readonly DomainLayout[] {
  const counts = new Map<string, number>();
  for (const atom of atoms) {
    if (!isAgentDomain(atom.domain)) {
      continue;
    }
    const namespace = atom.domain.slice("agent:".length);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return [...DOMAINS, ...dynamicDomainLayouts(counts)];
}

export function dynamicEdges(definitions: readonly AtomicDefinition[]): readonly EdgeLayout[] {
  void definitions;
  return [];
}

export function edgeRouteKey(edge: EdgeLayout): string {
  return `${edge.from}:${edge.to}:${edge.kind}`;
}

export function edgePairKey(edge: Pick<EdgeLayout, "from" | "to">): string {
  return `${edge.from}:${edge.to}`;
}

export function edgeLayoutKey(edge: EdgeLayout): string {
  const segmentOffsets = Object.entries(edge.segmentOffsets ?? {})
    .toSorted(([left], [right]) => Number(left) - Number(right))
    .map(([segment, offset]) => `${segment}:${offset}`)
    .join(",");
  const key = [
    edgeRouteKey(edge),
    edge.fromSide ?? "",
    edge.fromSlot ?? "",
    edge.toSide ?? "",
    edge.toSlot ?? "",
    segmentOffsets,
  ].join(":");
  const constraints = [
    ...(edge.routeBounds === undefined
      ? []
      : [
          `bounds=${edge.routeBounds.x},${edge.routeBounds.y},${edge.routeBounds.width},${edge.routeBounds.height}`,
        ]),
    ...(edge.fromMode === undefined && edge.toMode === undefined
      ? []
      : [`ports=${edge.fromMode ?? ""},${edge.toMode ?? ""}`]),
  ];
  return constraints.length === 0 ? key : `${key}:${constraints.join(":")}`;
}

function at(atom: AtomicDefinition, domain: DomainKey, x: number, y: number): AtomLayout {
  return {
    ...atom,
    domain,
    focus: focusForDomain(domain),
    width: atomLayoutWidth(atom, domain),
    x,
    y,
  };
}

export function atomNodeWidth(label: string, minimumWidth = ATOM_NODE_MIN_WIDTH): number {
  const textWidth = [...label].reduce((width, character) => {
    if (character === " ") {
      return width + 4;
    }
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return width + 12;
    }
    if (/[MW]/u.test(character)) {
      return width + 9;
    }
    if (/[A-Z]/u.test(character)) {
      return width + 8;
    }
    if (/[ilI1]/u.test(character)) {
      return width + 4;
    }
    return width + 6;
  }, 16);
  return Math.max(minimumWidth, Math.ceil(textWidth));
}

function atomLayoutWidth(atom: AtomicDefinition, domain: DomainKey): number {
  const minimumWidth =
    domain === "memory"
      ? MEMORY_ATOM_MIN_WIDTH
      : atom.kind === "skill"
        ? SKILL_ATOM_MIN_WIDTH
        : ATOM_NODE_MIN_WIDTH;
  return atomNodeWidth(atom.label, minimumWidth);
}

function edge(
  from: AtomicDefinition,
  to: AtomicDefinition,
  kind: EdgeLayout["kind"] = "execution",
  options: Pick<
    EdgeLayout,
    | "fromMode"
    | "fromSide"
    | "fromSlot"
    | "routeBounds"
    | "segmentOffsets"
    | "toMode"
    | "toSide"
    | "toSlot"
  > = {},
): EdgeLayout {
  return {
    from: from.key,
    ...options,
    kind,
    to: to.key,
  };
}

function domainLayoutsForDefinitions(
  definitions: readonly AtomicDefinition[],
): readonly DomainLayout[] {
  const known = new Set(ATOMS.map((atom) => atom.key));
  const counts = new Map<string, number>();
  for (const definition of definitions) {
    if (known.has(definition.key)) {
      continue;
    }
    const domain = domainForDefinition(definition);
    if (!isAgentDomain(domain)) {
      continue;
    }
    const namespace = domain.slice("agent:".length);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return [...DOMAINS, ...dynamicDomainLayouts(counts)];
}

function dynamicDomainLayouts(counts: ReadonlyMap<string, number>): readonly DomainLayout[] {
  let y = DOMAINS[0]?.y ?? 16;
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([namespace, count], index) => {
      const height = Math.max(300, 86 + Math.ceil(count / 2) * 78);
      const domain: DomainLayout = {
        height,
        key: `agent:${namespace}`,
        label: `${String(index + 7).padStart(2, "0")} · ${namespace.toUpperCase()} DOMAIN`,
        subtitle: `${namespace} agent semantics`,
        width: DYNAMIC_DOMAIN_WIDTH,
        x: DYNAMIC_DOMAIN_X,
        y,
      };
      y += height + DYNAMIC_DOMAIN_GAP;
      return domain;
    });
}

function domainForDefinition(definition: AtomicDefinition): DomainKey {
  const namespace = definition.key.split(".", 1)[0]?.trim().toLowerCase();
  if (namespace !== undefined && namespace !== "" && !RESERVED_NAMESPACES.has(namespace)) {
    return `agent:${namespace}`;
  }
  return domainForKind(definition.kind);
}

function domainForKind(kind: AtomicKind): SystemDomainKey {
  switch (kind) {
    case "eval":
    case "release":
      return "quality";
    case "agent":
    case "skill":
      return "capabilities";
    case "memory":
      return "memory";
    case "trace":
    case "trajectory":
      return "telemetry";
    case "input":
    case "context":
    case "hook":
    case "store":
      return "session";
    default:
      return "execution";
  }
}

function focusForDomain(domain: DomainKey): AtomFocus {
  return domain === "quality" || domain === "telemetry" ? "test" : "user";
}

function isAgentDomain(domain: DomainKey): domain is `agent:${string}` {
  return domain.startsWith("agent:");
}
