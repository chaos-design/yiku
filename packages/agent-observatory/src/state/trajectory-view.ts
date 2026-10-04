import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { projectTrajectory, type TrajectoryStep } from "@yiku/trajectory/browser";
import { createEventTurnIndex } from "./event-turn.js";

export interface TrajectoryViewRow {
  readonly ancestorIds: readonly string[];
  readonly atomKey: string;
  readonly depth: number;
  readonly durationMs?: number | undefined;
  readonly hasChildren: boolean;
  readonly id: string;
  readonly instanceCount: number;
  readonly iteration?: number | undefined;
  readonly kind: TrajectoryStep["kind"];
  readonly label: string;
  readonly parentId?: string | undefined;
  readonly sequence: number;
  readonly startedAt: string;
  readonly status: TrajectoryStep["status"];
  readonly summary: string;
  readonly turn?: number | undefined;
}

export function createTrajectoryView(
  events: readonly AtomicFlowEvent[],
  replaySequence: number,
): readonly TrajectoryViewRow[] {
  const visibleEvents = events
    .filter((event) => event.sequence <= replaySequence)
    .toSorted((left, right) => left.sequence - right.sequence);
  const firstEvent = visibleEvents[0];
  if (firstEvent === undefined) {
    return [];
  }
  const trajectory = projectTrajectory(visibleEvents, {
    runId: firstEvent.runId,
    throughSequence: replaySequence,
  });
  const turnIndex = createEventTurnIndex(visibleEvents);
  const stepsById = new Map(trajectory.steps.map((step) => [step.id, step]));
  const orderById = new Map(trajectory.steps.map((step, index) => [step.id, index]));
  const validParents = new Map<string, string>();
  const children = new Map<string, TrajectoryStep[]>();
  const instanceCounts = new Map<string, number>();
  const latestSequence = new Map<string, number>();

  for (const event of visibleEvents) {
    latestSequence.set(event.instance.id, event.sequence);
  }
  for (const step of trajectory.steps) {
    const key = step.atomKey ?? `${step.kind}:${step.name}`;
    instanceCounts.set(key, (instanceCounts.get(key) ?? 0) + 1);
    const parentId = validParentId(step, stepsById);
    if (parentId === undefined) {
      continue;
    }
    validParents.set(step.id, parentId);
    const entries = children.get(parentId) ?? [];
    entries.push(step);
    children.set(parentId, entries);
  }
  for (const entries of children.values()) {
    entries.sort((left, right) => (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0));
  }

  const rows: TrajectoryViewRow[] = [];
  const visited = new Set<string>();
  const append = (
    step: TrajectoryStep,
    ancestors: readonly string[],
    inheritedTurn?: number,
  ): void => {
    if (visited.has(step.id)) {
      return;
    }
    visited.add(step.id);
    const childSteps = children.get(step.id) ?? [];
    const atomKey = step.atomKey ?? step.name;
    const duration = durationMs(step);
    const sequence = latestSequence.get(step.id) ?? 0;
    const turn =
      atomKey === "run"
        ? undefined
        : (turnIndex.byInstanceId.get(step.id) ??
          turnIndex.bySequence.get(sequence) ??
          inheritedTurn);
    rows.push({
      ancestorIds: ancestors,
      atomKey,
      depth: ancestors.length,
      ...(duration !== undefined ? { durationMs: duration } : {}),
      hasChildren: childSteps.length > 0,
      id: step.id,
      instanceCount: instanceCounts.get(step.atomKey ?? `${step.kind}:${step.name}`) ?? 1,
      ...(step.iteration !== undefined ? { iteration: step.iteration } : {}),
      kind: step.kind,
      label: step.name,
      ...(validParents.get(step.id) !== undefined ? { parentId: validParents.get(step.id) } : {}),
      sequence,
      startedAt: step.startedAt,
      status: step.status,
      summary: stepSummary(step),
      ...(turn !== undefined ? { turn } : {}),
    });
    for (const child of childSteps) {
      append(child, [...ancestors, step.id], turn);
    }
  };

  for (const step of trajectory.steps) {
    if (!validParents.has(step.id)) {
      append(step, []);
    }
  }
  for (const step of trajectory.steps) {
    append(step, []);
  }
  return rows;
}

function validParentId(
  step: TrajectoryStep,
  stepsById: ReadonlyMap<string, TrajectoryStep>,
): string | undefined {
  const parentId = step.parentId;
  if (parentId === undefined || !stepsById.has(parentId) || parentId === step.id) {
    return undefined;
  }
  const visited = new Set([step.id]);
  let current: string | undefined = parentId;
  while (current !== undefined) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    current = stepsById.get(current)?.parentId;
  }
  return parentId;
}

function durationMs(step: TrajectoryStep): number | undefined {
  if (step.endedAt === undefined) {
    return undefined;
  }
  const startedAt = Date.parse(step.startedAt);
  const endedAt = Date.parse(step.endedAt);
  return Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : undefined;
}

function stepSummary(step: TrajectoryStep): string {
  if (step.error !== undefined) {
    return step.error;
  }
  const output = asRecord(step.output);
  return typeof output?.summary === "string" && output.summary.trim() ? output.summary : step.name;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
