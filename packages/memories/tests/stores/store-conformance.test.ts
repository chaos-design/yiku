import { afterEach, describe, expect, it } from "vitest";
import { MemoryAbortError, MemoryConflictError, MemoryStoreError } from "../../src/errors.js";
import { InMemoryMemoryStore } from "../../src/stores/in-memory-store.js";
import type { MemoryContext, MemoryStore, StoredMemory } from "../../src/types.js";

type StoreFactory = () => MemoryStore | Promise<MemoryStore>;

export function runMemoryStoreConformance(name: string, factory: StoreFactory): void {
  describe(`${name} MemoryStore conformance`, () => {
    const stores: MemoryStore[] = [];

    afterEach(async () => {
      await Promise.all(stores.splice(0).map((store) => store.close()));
    });

    async function createStore(): Promise<MemoryStore> {
      const store = await factory();
      stores.push(store);
      await store.initialize();
      return store;
    }

    it("requires initialization and honors initialization abort", async () => {
      const store = await factory();
      stores.push(store);
      const controller = new AbortController();
      controller.abort();

      await expect(store.get({ context: context(), id: "missing" })).rejects.toThrow(
        MemoryStoreError,
      );
      await expect(store.initialize({ signal: controller.signal })).rejects.toThrow(
        MemoryAbortError,
      );
      await expect(store.initialize()).resolves.toBeUndefined();
    });

    it("inserts, merges duplicates, and isolates returned values", async () => {
      const store = await createStore();
      const first = stored({
        confidence: 0.4,
        id: "first",
        importance: 0.2,
        metadata: { first: true },
        tags: ["one"],
      });

      const [inserted] = await store.rememberMany([first]);
      const [merged] = await store.rememberMany([
        stored({
          confidence: 0.9,
          fingerprint: first.fingerprint,
          id: "duplicate",
          importance: 0.8,
          metadata: { second: true },
          tags: ["two"],
          updatedAt: "2026-07-31T01:00:00.000Z",
        }),
      ]);

      expect(inserted).toEqual(first);
      expect(merged).toMatchObject({
        confidence: 0.9,
        id: "first",
        importance: 0.8,
        metadata: {
          first: true,
          second: true,
        },
        revision: 2,
        tags: ["one", "two"],
      });

      if (merged === undefined) {
        throw new Error("Store did not return a merged record.");
      }

      (merged.tags as string[]).push("mutated");
      await expect(store.get({ context: context(), id: "first" })).resolves.not.toMatchObject({
        tags: ["one", "two", "mutated"],
      });
    });

    it("replays equivalent idempotent writes and rejects conflicting reuse atomically", async () => {
      const store = await createStore();
      const idempotent = stored({
        id: "idempotent",
        idempotencyHash: "hash",
        idempotencyKey: "request-1",
      });

      const [first] = await store.rememberMany([idempotent]);
      const [replayed] = await store.rememberMany([
        {
          ...idempotent,
          id: "ignored",
        },
      ]);

      expect(replayed).toEqual(first);
      await expect(
        store.rememberMany([
          stored({ id: "new-in-batch" }),
          {
            ...idempotent,
            id: "conflict",
            idempotencyHash: "other",
          },
        ]),
      ).rejects.toThrow(MemoryConflictError);
      await expect(store.get({ context: context(), id: "new-in-batch" })).resolves.toBeUndefined();
    });

    it("enforces namespace and hierarchical scope applicability", async () => {
      const store = await createStore();
      await store.rememberMany([
        stored({ id: "global" }),
        stored({
          id: "project",
          scope: { projectId: "repo" },
          scopeKey: "project",
        }),
        stored({
          id: "user",
          scope: { projectId: "repo", userId: "alice" },
          scopeKey: "user",
        }),
        stored({
          id: "other-tenant",
          namespace: "other",
        }),
      ]);

      const queryContext = context({ projectId: "repo", userId: "alice" });
      await expect(store.get({ context: queryContext, id: "global" })).resolves.toBeDefined();
      await expect(store.get({ context: queryContext, id: "project" })).resolves.toBeDefined();
      await expect(store.get({ context: queryContext, id: "user" })).resolves.toBeDefined();
      await expect(
        store.get({ context: context({ projectId: "repo" }), id: "user" }),
      ).resolves.toBeUndefined();
      await expect(
        store.get({ context: { namespace: "tenant" }, id: "other-tenant" }),
      ).resolves.toBeUndefined();
    });

    it("counts active, applicable, and unexpired records by kind", async () => {
      const store = await createStore();
      await store.rememberMany([
        stored({ id: "fact", kind: "fact" }),
        stored({ id: "procedure", kind: "procedure" }),
        stored({
          expiresAt: "2026-07-30T00:00:00.000Z",
          id: "expired",
          kind: "episode",
        }),
        stored({
          id: "other-project",
          kind: "decision",
          scope: { projectId: "other" },
          scopeKey: "other",
        }),
      ]);

      await expect(
        store.countByKind({
          context: context({ projectId: "repo" }),
          now: "2026-07-31T00:00:00.000Z",
        }),
      ).resolves.toEqual({
        decision: 0,
        episode: 0,
        fact: 1,
        preference: 0,
        procedure: 1,
      });
    });

    it("updates with optimistic revisions and rejects uniqueness conflicts", async () => {
      const store = await createStore();
      const [first, second] = await store.rememberMany([
        stored({ id: "first" }),
        stored({ id: "second" }),
      ]);

      if (first === undefined || second === undefined) {
        throw new Error("Store did not return inserted records.");
      }

      const updated = await store.update({
        context: context(),
        expectedRevision: 1,
        memory: {
          ...first,
          content: "updated",
          fingerprint: "updated",
          normalizedContent: "updated",
          updatedAt: "2026-07-31T02:00:00.000Z",
        },
      });

      expect(updated).toMatchObject({
        content: "updated",
        revision: 2,
      });
      await expect(
        store.update({
          context: context(),
          expectedRevision: 1,
          memory: updated,
        }),
      ).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
      await expect(
        store.update({
          context: context(),
          expectedRevision: 2,
          memory: {
            ...updated,
            fingerprint: second.fingerprint,
          },
        }),
      ).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });
      await expect(
        store.update({
          context: context(),
          expectedRevision: 1,
          memory: stored({ id: "missing" }),
        }),
      ).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    });

    it("returns filtered lexical and semantic candidates deterministically", async () => {
      const store = await createStore();
      await store.rememberMany([
        stored({
          content: "TypeScript memory architecture",
          embedding: embedding([1, 0]),
          id: "hybrid",
          normalizedContent: "TypeScript memory architecture",
          tags: ["architecture"],
        }),
        stored({
          content: "Unrelated content",
          embedding: embedding([0, 1]),
          id: "semantic",
          kind: "decision",
          normalizedContent: "Unrelated content",
          tags: ["architecture"],
        }),
        stored({
          content: "Expired TypeScript",
          expiresAt: "2026-01-01T00:00:00.000Z",
          id: "expired",
          normalizedContent: "Expired TypeScript",
        }),
      ]);

      const result = await store.search({
        context: context(),
        embeddingModel: "test",
        kinds: ["fact", "decision"],
        lexicalLimit: 10,
        now: "2026-07-31T00:00:00.000Z",
        query: "typescript memory",
        queryEmbedding: [1, 0],
        tags: ["architecture"],
        vectorLimit: 10,
        vectorScanLimit: 10,
      });

      expect(result.lexical.map((candidate) => candidate.memory.id)).toEqual(["hybrid"]);
      expect(result.vector.map((candidate) => candidate.memory.id)).toEqual(["hybrid", "semantic"]);
      expect(result.vector[0]).toMatchObject({ rank: 1, score: 1 });
      expect(result.vectorScanExceeded).toBe(false);
    });

    it("reports vector scan degradation and skips invalid stored vectors", async () => {
      const store = await createStore();
      await store.rememberMany([
        stored({ embedding: embedding([1, 0]), id: "one" }),
        stored({ embedding: embedding([0, 0]), id: "invalid" }),
      ]);
      const baseSearch = {
        context: context(),
        embeddingModel: "test",
        lexicalLimit: 10,
        now: "2026-07-31T00:00:00.000Z",
        query: "missing",
        queryEmbedding: [1, 0],
        vectorLimit: 10,
      } as const;

      await expect(
        store.search({
          ...baseSearch,
          vectorScanLimit: 1,
        }),
      ).resolves.toMatchObject({
        vector: [],
        vectorScanExceeded: true,
      });
      await expect(
        store.search({
          ...baseSearch,
          vectorScanLimit: 10,
        }),
      ).resolves.toMatchObject({
        vector: [expect.objectContaining({ memory: expect.objectContaining({ id: "one" }) })],
        vectorScanExceeded: false,
      });
    });

    it("touches, soft deletes, hard deletes, and prunes applicable records", async () => {
      const store = await createStore();
      await store.rememberMany([
        stored({ id: "touch" }),
        stored({ id: "soft" }),
        stored({
          expiresAt: "2026-01-01T00:00:00.000Z",
          id: "expired",
        }),
      ]);

      await store.touch({
        context: context(),
        ids: ["touch", "touch", "missing"],
        touchedAt: "2026-07-31T02:00:00.000Z",
      });
      await expect(store.get({ context: context(), id: "touch" })).resolves.toMatchObject({
        accessCount: 1,
        lastAccessedAt: "2026-07-31T02:00:00.000Z",
      });

      await expect(
        store.forget({
          context: context(),
          id: "soft",
          mode: "soft",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ).resolves.toBe(true);
      await expect(store.get({ context: context(), id: "soft" })).resolves.toBeUndefined();
      await expect(
        store.forget({
          context: context(),
          id: "soft",
          mode: "soft",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ).resolves.toBe(false);
      await expect(
        store.forget({
          context: context(),
          id: "soft",
          mode: "hard",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ).resolves.toBe(true);
      await expect(
        store.forget({
          context: context(),
          id: "missing",
          mode: "hard",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ).resolves.toBe(false);

      await expect(
        store.prune({
          before: "2026-07-15T00:00:00.000Z",
          context: context(),
          now: "2026-07-31T00:00:00.000Z",
        }),
      ).resolves.toEqual({ deleted: 1 });
      await expect(store.get({ context: context(), id: "expired" })).resolves.toBeUndefined();
    });

    it("closes idempotently and rejects later operations", async () => {
      const store = await createStore();

      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.initialize()).rejects.toMatchObject({ code: "MEMORY_STORE_CLOSED" });
    });
  });
}

runMemoryStoreConformance("in-memory", () => new InMemoryMemoryStore());

function context(scope: MemoryContext["scope"] = {}): MemoryContext {
  return {
    namespace: "tenant",
    scope,
  };
}

function embedding(values: readonly number[]) {
  return {
    dimensions: values.length,
    model: "test",
    values,
  };
}

function stored(overrides: Partial<StoredMemory>): StoredMemory {
  const id = overrides.id ?? "memory";
  const scope = overrides.scope ?? {};

  return {
    accessCount: 0,
    confidence: 0.5,
    content: id,
    createdAt: "2026-07-31T00:00:00.000Z",
    fingerprint: overrides.fingerprint ?? id,
    id,
    importance: 0.5,
    kind: "fact",
    metadata: {},
    namespace: "tenant",
    normalizedContent: id,
    revision: 1,
    scope,
    scopeKey: overrides.scopeKey ?? JSON.stringify(scope),
    source: {
      type: "user",
    },
    status: "active",
    tags: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}
