import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";

const RUN_LEVEL_ATOMS = new Set([
  "context.compact",
  "hook.dispatch",
  "hook.execute",
  "input.prompt",
  "run",
  "session.checkpoint",
  "session.resume",
  "stage.finish",
  "stage.start",
  "task.snapshot",
]);

export interface EventTurnIndex {
  readonly byInstanceId: ReadonlyMap<string, number>;
  readonly bySequence: ReadonlyMap<number, number>;
  readonly turns: readonly number[];
}

export function createEventTurnIndex(events: readonly AtomicFlowEvent[]): EventTurnIndex {
  const orderedEvents = [...events].toSorted((left, right) => left.sequence - right.sequence);
  const explicitTurns = new Map<string, number>();
  const parents = new Map<string, string>();

  for (const event of orderedEvents) {
    const turn = eventTurn(event);
    if (turn !== undefined) {
      explicitTurns.set(event.instance.id, turn);
    }
    if (event.instance.parentId !== undefined) {
      parents.set(event.instance.id, event.instance.parentId);
    }
  }

  let fallbackTurn = 1;
  const usedTurns = new Set(explicitTurns.values());
  const loopInstances = new Set<string>();
  for (const event of orderedEvents) {
    if (event.atom.key !== "loop.turn" || loopInstances.has(event.instance.id)) {
      continue;
    }
    loopInstances.add(event.instance.id);
    const explicit = explicitTurns.get(event.instance.id);
    if (explicit !== undefined) {
      fallbackTurn = Math.max(fallbackTurn, explicit + 1);
      continue;
    }
    while (usedTurns.has(fallbackTurn)) {
      fallbackTurn += 1;
    }
    explicitTurns.set(event.instance.id, fallbackTurn);
    usedTurns.add(fallbackTurn);
    fallbackTurn += 1;
  }

  const resolvedTurns = new Map<string, number>();
  const resolveInstanceTurn = (
    instanceId: string,
    visiting = new Set<string>(),
  ): number | undefined => {
    const cached = resolvedTurns.get(instanceId);
    if (cached !== undefined) {
      return cached;
    }
    const explicit = explicitTurns.get(instanceId);
    if (explicit !== undefined) {
      resolvedTurns.set(instanceId, explicit);
      return explicit;
    }
    if (visiting.has(instanceId)) {
      return undefined;
    }
    const parentId = parents.get(instanceId);
    if (parentId === undefined) {
      return undefined;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(instanceId);
    const inherited = resolveInstanceTurn(parentId, nextVisiting);
    if (inherited !== undefined) {
      resolvedTurns.set(instanceId, inherited);
    }
    return inherited;
  };

  for (const event of orderedEvents) {
    resolveInstanceTurn(event.instance.id);
  }

  const bySequence = new Map<number, number>();
  const turns: number[] = [];
  const seenTurns = new Set<number>();
  let currentTurn: number | undefined;
  for (const event of orderedEvents) {
    const resolved = resolvedTurns.get(event.instance.id);
    if (
      event.atom.key === "loop.turn" &&
      (event.phase === "scheduled" || event.phase === "start")
    ) {
      currentTurn = resolved;
    }
    const turn = resolved ?? (RUN_LEVEL_ATOMS.has(event.atom.key) ? undefined : currentTurn);
    if (turn === undefined) {
      continue;
    }
    bySequence.set(event.sequence, turn);
    if (!seenTurns.has(turn)) {
      seenTurns.add(turn);
      turns.push(turn);
    }
  }

  return {
    byInstanceId: resolvedTurns,
    bySequence,
    turns,
  };
}

function eventTurn(event: AtomicFlowEvent): number | undefined {
  const iteration = event.instance.iteration ?? event.payload?.values?.iteration;
  return typeof iteration === "number" && Number.isSafeInteger(iteration) && iteration > 0
    ? iteration
    : undefined;
}
