import { describe, expect, it, vi } from "vitest";
import { StudioRunRegistry } from "../../src/server/run-registry.js";
import type { StoredStudioRun, StudioStore } from "../../src/server/types.js";
import type { StudioEvent, StudioRunSeed, StudioRunSummary } from "../../src/types.js";

class MemoryStore implements StudioStore {
  public readonly events: StudioEvent[] = [];
  public readonly runs: StudioRunSummary[] = [];

  public constructor(private readonly initial: readonly StoredStudioRun[] = []) {}

  public async initialize(): Promise<readonly StoredStudioRun[]> {
    return this.initial;
  }

  public async appendEvent(event: StudioEvent): Promise<void> {
    this.events.push(event);
  }

  public async writeRun(run: StudioRunSummary): Promise<void> {
    this.runs.push(run);
  }

  public async close(): Promise<void> {}
}

const event = (sequence: number, runId = "run-1"): StudioEvent => ({
  eventId: `${runId}-event-${sequence}`,
  occurredAt: `2026-08-07T00:00:0${sequence}.000Z`,
  runId,
  sequence,
});

const seed = (runId = "run-1"): StudioRunSeed => ({
  createdAt: "2026-08-07T00:00:00.000Z",
  runId,
  status: "running",
  title: `Run ${runId}`,
});

describe("StudioRunRegistry", () => {
  it("ingests, projects, publishes and lists events", async () => {
    const store = new MemoryStore();
    const registry = new StudioRunRegistry({
      projectors: [
        {
          id: "completion",
          project: ({ event: nextEvent }) =>
            nextEvent.sequence === 2 ? { status: "completed" } : {},
        },
      ],
      store,
    });
    await registry.initialize();
    await registry.ingest(event(1), seed());
    const listener = vi.fn();
    registry.subscribe("run-1", listener);

    await expect(registry.ingest(event(2), seed())).resolves.toEqual({
      duplicate: false,
      expectedSequence: 3,
      runId: "run-1",
    });

    expect(registry.get("run-1")).toEqual(
      expect.objectContaining({
        eventCount: 2,
        events: [event(1), event(2)],
        status: "completed",
      }),
    );
    expect(listener).toHaveBeenCalledWith(event(2));
    expect(store.events).toHaveLength(2);
    await registry.close();
  });

  it("accepts exact duplicates and rejects gaps or conflicts", async () => {
    const store = new MemoryStore();
    const registry = new StudioRunRegistry({ store });
    await registry.initialize();
    await registry.ingest(event(1), seed());

    await expect(registry.ingest(event(1), seed())).resolves.toEqual({
      duplicate: true,
      expectedSequence: 2,
      runId: "run-1",
    });
    await expect(registry.ingest(event(3), seed())).rejects.toMatchObject({
      code: "STUDIO_INGESTION_CONFLICT",
      details: { expectedSequence: 2 },
    });
    await expect(
      registry.ingest({ ...event(1), eventId: "different" }, seed()),
    ).rejects.toMatchObject({
      code: "STUDIO_INGESTION_CONFLICT",
    });
  });

  it("restores stored runs and keeps independent run queues", async () => {
    const first = event(1);
    const restoredRun: StudioRunSummary = {
      createdAt: first.occurredAt,
      eventCount: 1,
      runId: first.runId,
      status: "running",
      title: "Restored",
      updatedAt: first.occurredAt,
    };
    const store = new MemoryStore([{ events: [first], run: restoredRun }]);
    const registry = new StudioRunRegistry({ store });
    await registry.initialize();

    await Promise.all([
      registry.ingest(event(2), seed()),
      registry.ingest(event(1, "run-2"), {
        ...seed("run-2"),
        createdAt: "2026-08-07T00:00:02.000Z",
      }),
    ]);

    expect(registry.list().map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    expect(registry.events("run-1", 1)).toEqual([event(2)]);
  });

  it("rejects invalid events and projector output before persistence", async () => {
    const store = new MemoryStore();
    const registry = new StudioRunRegistry({
      projectors: [{ id: "bad", project: () => ({ runId: "changed" }) }],
      store,
    });
    await registry.initialize();

    expect(() => registry.ingest({ ...event(1), sequence: 0 }, seed())).toThrow(
      expect.objectContaining({ code: "STUDIO_INVALID_REQUEST" }),
    );
    await expect(registry.ingest(event(1), seed())).rejects.toThrow("cannot change");
    expect(store.events).toEqual([]);
  });

  it("validates event envelopes, seeds and projector fields", async () => {
    const registry = new StudioRunRegistry({ store: new MemoryStore() });
    await registry.initialize();
    for (const invalid of [
      { ...event(1), eventId: "" },
      { ...event(1), eventId: "x".repeat(257) },
      { ...event(1), runId: "" },
      { ...event(1), runId: "x".repeat(129) },
      { ...event(1), occurredAt: "invalid" },
      { ...event(1), occurredAt: "2026-08-07" },
    ]) {
      expect(() => registry.ingest(invalid, { ...seed(), runId: invalid.runId })).toThrow(
        expect.objectContaining({ code: "STUDIO_INVALID_REQUEST" }),
      );
    }
    expect(() => registry.ingest(event(1), seed("other"))).toThrow("seed does not match");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.events("missing")).toEqual([]);
    expect(registry.subscribe("missing", vi.fn())).toBeUndefined();

    for (const patch of [{ status: "" }, { title: "" }, { eventCount: -1 }]) {
      const invalidProjector = new StudioRunRegistry({
        projectors: [{ id: "invalid", project: () => patch }],
        store: new MemoryStore(),
      });
      await invalidProjector.initialize();
      await expect(invalidProjector.ingest(event(1), seed())).rejects.toMatchObject({
        code: "STUDIO_INVALID_REQUEST",
      });
    }
  });

  it("merges seed metadata and removes empty listener sets", async () => {
    const registry = new StudioRunRegistry({ store: new MemoryStore() });
    await registry.initialize();
    await registry.ingest(event(1), {
      ...seed(),
      extensions: { first: true },
      metadata: { existing: "first" },
    });
    const listener = vi.fn();
    const unsubscribe = registry.subscribe("run-1", listener);
    unsubscribe?.();
    await registry.ingest(event(2), {
      ...seed(),
      extensions: { first: false, second: true },
      metadata: { existing: "second", next: "value" },
    });

    expect(listener).not.toHaveBeenCalled();
    expect(registry.get("run-1")).toMatchObject({
      extensions: { first: true, second: true },
      metadata: { existing: "first", next: "value" },
    });
  });
});
