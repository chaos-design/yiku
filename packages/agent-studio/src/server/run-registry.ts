import { isDeepStrictEqual } from "node:util";
import type { StudioEvent, StudioRunDetail, StudioRunSeed, StudioRunSummary } from "../types.js";
import { ingestionConflict, invalidRequest } from "./errors.js";
import type { StudioIngestResult, StudioRunProjector, StudioStore } from "./types.js";

export interface StudioRunRegistryOptions {
  readonly projectors?: readonly StudioRunProjector[] | undefined;
  readonly store: StudioStore;
}

interface RunRecord {
  readonly events: StudioEvent[];
  run: StudioRunSummary;
}

export class StudioRunRegistry {
  private readonly listeners = new Map<string, Set<(event: StudioEvent) => void>>();
  private readonly projectors: readonly StudioRunProjector[];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly records = new Map<string, RunRecord>();
  private readonly store: StudioStore;

  public constructor(options: StudioRunRegistryOptions) {
    this.projectors = options.projectors ?? [];
    this.store = options.store;
  }

  public async initialize(): Promise<void> {
    for (const stored of await this.store.initialize()) {
      if (!this.records.has(stored.run.runId)) {
        this.records.set(stored.run.runId, {
          events: [...stored.events],
          run: stored.run,
        });
      }
    }
  }

  public ingest(event: StudioEvent, seed: StudioRunSeed): Promise<StudioIngestResult> {
    validateEvent(event);
    if (seed.runId !== event.runId) {
      throw invalidRequest("Studio run seed does not match the event Run ID.");
    }
    return this.enqueue(event.runId, () => this.ingestEvent(event, seed));
  }

  public list(): readonly StudioRunSummary[] {
    return [...this.records.values()]
      .map((record) => record.run)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public get(runId: string): StudioRunDetail | undefined {
    const record = this.records.get(runId);
    return record === undefined
      ? undefined
      : {
          ...record.run,
          events: [...record.events],
        };
  }

  public events(runId: string, afterSequence = 0): readonly StudioEvent[] {
    return this.records.get(runId)?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  public subscribe(
    runId: string,
    listener: (event: StudioEvent) => void,
  ): (() => void) | undefined {
    if (!this.records.has(runId)) {
      return undefined;
    }
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  public async close(): Promise<void> {
    await Promise.allSettled(this.queues.values());
    this.listeners.clear();
    await this.store.close();
  }

  private async ingestEvent(event: StudioEvent, seed: StudioRunSeed): Promise<StudioIngestResult> {
    const existing = this.records.get(event.runId);
    const events = existing?.events ?? [];
    const expectedSequence = (events.at(-1)?.sequence ?? 0) + 1;

    if (event.sequence < expectedSequence) {
      const duplicate = events.find((candidate) => candidate.sequence === event.sequence);
      if (duplicate?.eventId === event.eventId && isDeepStrictEqual(duplicate, event)) {
        if (existing !== undefined) {
          await this.store.writeRun(existing.run);
        }
        return {
          duplicate: true,
          expectedSequence,
          runId: event.runId,
        };
      }
      throw ingestionConflict("Studio event conflicts with a stored sequence.", expectedSequence);
    }
    if (event.sequence > expectedSequence) {
      throw ingestionConflict("Studio event sequence contains a gap.", expectedSequence);
    }

    const nextEvents = [...events, event];
    let nextRun: StudioRunSummary =
      existing === undefined
        ? {
            createdAt: seed.createdAt,
            eventCount: 0,
            ...(seed.extensions !== undefined ? { extensions: seed.extensions } : {}),
            ...(seed.metadata !== undefined ? { metadata: seed.metadata } : {}),
            runId: seed.runId,
            status: seed.status,
            title: seed.title,
            updatedAt: seed.updatedAt ?? seed.createdAt,
          }
        : {
            ...existing.run,
            ...(seed.extensions === undefined
              ? {}
              : {
                  extensions: {
                    ...seed.extensions,
                    ...existing.run.extensions,
                  },
                }),
            ...(seed.metadata === undefined
              ? {}
              : {
                  metadata: {
                    ...seed.metadata,
                    ...existing.run.metadata,
                  },
                }),
          };
    nextRun = {
      ...nextRun,
      eventCount: nextEvents.length,
      updatedAt: event.occurredAt,
    };
    for (const projector of this.projectors) {
      nextRun = {
        ...nextRun,
        ...(await projector.project({
          current: nextRun,
          event,
          events: nextEvents,
        })),
      };
      validateRun(nextRun, event.runId);
    }

    await this.store.appendEvent(event);
    const record = existing ?? { events: [], run: nextRun };
    record.events.push(event);
    record.run = nextRun;
    this.records.set(event.runId, record);
    await this.store.writeRun(nextRun);

    for (const listener of this.listeners.get(event.runId) ?? []) {
      listener(event);
    }
    return {
      duplicate: false,
      expectedSequence: expectedSequence + 1,
      runId: event.runId,
    };
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(runId, settled);
    void settled.finally(() => {
      if (this.queues.get(runId) === settled) {
        this.queues.delete(runId);
      }
    });
    return current;
  }
}

function validateEvent(event: StudioEvent): void {
  if (!event.eventId.trim() || event.eventId.length > 256) {
    throw invalidRequest("Studio Event ID must be non-empty and at most 256 characters.");
  }
  if (!event.runId.trim() || event.runId.length > 128) {
    throw invalidRequest("Studio Run ID must be non-empty and at most 128 characters.");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    throw invalidRequest("Studio event Sequence must be a positive safe integer.");
  }
  try {
    if (new Date(event.occurredAt).toISOString() !== event.occurredAt) {
      throw new Error();
    }
  } catch {
    throw invalidRequest("Studio event timestamp must be an ISO timestamp.");
  }
}

function validateRun(run: StudioRunSummary, expectedRunId: string): void {
  if (run.runId !== expectedRunId) {
    throw invalidRequest("Studio Run Projector cannot change the Run ID.");
  }
  if (!run.title.trim() || !run.status.trim()) {
    throw invalidRequest("Studio Run Projector returned an invalid title or status.");
  }
  if (!Number.isSafeInteger(run.eventCount) || run.eventCount < 0) {
    throw invalidRequest("Studio Run Projector returned an invalid event count.");
  }
}
