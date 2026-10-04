import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryAbortError,
  MemoryEmbeddingError,
  MemoryExtractionError,
  MemoryStoreError,
  MemoryValidationError,
} from "../src/errors.js";
import { MemoryManager } from "../src/manager.js";
import { DefaultMemoryPolicy } from "../src/policy/default-policy.js";
import { InMemoryMemoryStore } from "../src/stores/in-memory-store.js";
import type {
  EmbeddingProvider,
  MemoryExtractor,
  MemoryOperationEvent,
  MemoryStore,
  RememberMemoryInput,
} from "../src/types.js";

const context = {
  namespace: "tenant",
  scope: {
    projectId: "repo",
    userId: "alice",
  },
} as const;

describe("MemoryManager", () => {
  it("runs the write, recall, update, deletion, prune, and close lifecycle", async () => {
    const store = new InMemoryMemoryStore();
    const events: MemoryOperationEvent[] = [];
    const provider = embeddingProvider((text) =>
      text.toLowerCase().includes("typescript") ? [1, 0] : [0, 1],
    );
    const manager = createManager({
      embeddingProvider: provider,
      events,
      policy: new DefaultMemoryPolicy({
        defaultRetentionMs: {
          fact: 86_400_000,
        },
      }),
      store,
    });

    const inserted = await manager.remember({
      confidence: 0.8,
      content: "TypeScript token=super-secret",
      context,
      importance: 0.9,
      kind: "fact",
      metadata: {
        language: "TypeScript",
      },
      tags: ["language"],
    });

    expect(inserted).toMatchObject({
      confidence: 0.8,
      content: "TypeScript [REDACTED]",
      expiresAt: "2026-08-01T00:00:00.000Z",
      id: "memory-1",
      importance: 0.9,
      revision: 1,
    });
    expect(events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: expect.anything() })]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEMORY_CONTENT_REDACTED",
          operation: "remember",
          phase: "end",
        }),
      ]),
    );

    const recalled = await manager.recall({
      context,
      query: "typescript",
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({
      memory: {
        id: "memory-1",
      },
      reasons: expect.arrayContaining(["LEXICAL_MATCH", "SEMANTIC_MATCH"]),
    });
    await expect(manager.get({ context, id: "memory-1" })).resolves.toMatchObject({
      accessCount: 1,
      lastAccessedAt: "2026-07-31T00:00:00.000Z",
    });

    const updated = await manager.update({
      context,
      expectedRevision: 1,
      id: "memory-1",
      patch: {
        confidence: 1,
        content: "Use modern TypeScript",
        expiresAt: null,
        importance: 1,
        kind: "procedure",
        metadata: {
          updated: true,
        },
        source: {
          id: "manual",
          type: "user",
        },
        tags: ["updated"],
      },
    });

    expect(updated).toMatchObject({
      confidence: 1,
      content: "Use modern TypeScript",
      importance: 1,
      kind: "procedure",
      metadata: {
        updated: true,
      },
      revision: 2,
      tags: ["updated"],
    });
    expect(updated).not.toHaveProperty("expiresAt");

    await expect(
      manager.forget({
        context,
        id: "memory-1",
      }),
    ).resolves.toBe(true);
    await expect(manager.get({ context, id: "memory-1" })).resolves.toBeUndefined();
    await expect(
      manager.forget({
        context,
        id: "memory-1",
        mode: "hard",
      }),
    ).resolves.toBe(true);

    await manager.remember({
      content: "expired",
      context,
      expiresAt: "2026-01-01T00:00:00.000Z",
      kind: "episode",
    });
    await expect(
      manager.prune({
        before: "2026-07-01T00:00:00.000Z",
        context,
      }),
    ).resolves.toEqual({ deleted: 1 });

    await manager.close();
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(
      manager.remember({
        content: "closed",
        context,
        kind: "fact",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_MANAGER_CLOSED" });
  });

  it("merges duplicate writes and validates batch boundaries", async () => {
    const manager = createManager();
    const input: RememberMemoryInput = {
      confidence: 0.2,
      content: "same content",
      context,
      importance: 0.3,
      kind: "fact",
      tags: ["one"],
    };

    const first = await manager.remember(input);
    const second = await manager.remember({
      ...input,
      confidence: 0.9,
      importance: 0.8,
      tags: ["two"],
    });

    expect(second).toMatchObject({
      confidence: 0.9,
      id: first.id,
      importance: 0.8,
      revision: 2,
      tags: ["one", "two"],
    });
    await expect(manager.rememberMany([])).resolves.toEqual([]);
    await expect(
      manager.rememberMany([
        input,
        {
          ...input,
          context: {
            namespace: "other",
          },
        },
      ]),
    ).rejects.toBeInstanceOf(MemoryValidationError);

    const limited = createManager({
      policy: new DefaultMemoryPolicy({ maxBatchSize: 1 }),
    });
    await expect(limited.rememberMany([input, input])).rejects.toThrow("batch exceeds");
  });

  it("extracts only accepted session drafts and assigns session provenance", async () => {
    const extractor: MemoryExtractor = {
      extract: vi.fn(async () => [
        {
          confidence: 0.9,
          content: "User prefers concise answers",
          importance: 0.8,
          kind: "preference" as const,
          tags: ["preference"],
        },
        {
          confidence: 0.2,
          content: "Low confidence",
          importance: 0.1,
          kind: "fact" as const,
        },
      ]),
    };
    const manager = createManager({ extractor });
    const result = await manager.ingestSession({
      agentId: "code",
      context,
      output: "I will keep answers concise.",
      projectId: "repo",
      prompt: "Keep answers concise.",
      sessionId: "session-1",
      userId: "alice",
    });

    expect(result).toMatchObject({
      discarded: 1,
      extracted: 2,
      memories: [
        expect.objectContaining({
          kind: "preference",
          source: {
            id: "session-1",
            type: "session",
          },
        }),
      ],
    });
    expect(extractor.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        sessionId: "session-1",
      }),
      expect.any(Object),
    );
  });

  it("reports extraction configuration, provider, and output failures", async () => {
    await expect(
      createManager().ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).rejects.toBeInstanceOf(MemoryExtractionError);

    const throwing = createManager({
      extractor: {
        async extract() {
          throw new Error("provider failed");
        },
      },
    });
    await expect(
      throwing.ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_EXTRACTION_FAILED" });

    const invalid = createManager({
      extractor: {
        async extract() {
          return null as never;
        },
      },
    });
    await expect(
      invalid.ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_EXTRACTION_FAILED" });
  });

  it("degrades embedding failures to lexical mode by default", async () => {
    const events: MemoryOperationEvent[] = [];
    const manager = createManager({
      embeddingProvider: embeddingProvider(() => {
        throw new Error("offline");
      }),
      events,
    });

    await manager.remember({
      content: "lexical fallback",
      context,
      kind: "fact",
    });
    await expect(
      manager.recall({
        context,
        query: "fallback",
      }),
    ).resolves.toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEMORY_EMBEDDING_FAILED",
          mode: "lexical",
          phase: "end",
        }),
      ]),
    );
  });

  it.each([
    {
      name: "wrong count",
      provider: {
        dimensions: 2,
        model: "test",
        async embed() {
          return [];
        },
      },
    },
    {
      name: "wrong dimensions",
      provider: embeddingProvider(() => [1]),
    },
    {
      name: "non-finite value",
      provider: embeddingProvider(() => [Number.NaN, 1]),
    },
    {
      name: "zero magnitude",
      provider: embeddingProvider(() => [0, 0]),
    },
  ])("rejects $name embeddings in strict mode", async ({ provider }) => {
    const manager = createManager({
      embeddingProvider: provider,
      policy: new DefaultMemoryPolicy({
        embeddingFailureMode: "error",
      }),
    });

    await expect(
      manager.remember({
        content: "strict embedding",
        context,
        kind: "fact",
      }),
    ).rejects.toBeInstanceOf(MemoryEmbeddingError);
  });

  it("batches embeddings and preserves them for metadata-only updates", async () => {
    const provider = embeddingProvider(() => [1, 0]);
    const manager = createManager({
      embeddingProvider: provider,
      policy: new DefaultMemoryPolicy({
        embeddingBatchSize: 1,
      }),
    });
    const records = await manager.rememberMany([
      {
        content: "first",
        context,
        kind: "fact",
      },
      {
        content: "second",
        context,
        kind: "decision",
      },
    ]);

    expect(provider.embed).toHaveBeenCalledTimes(2);
    const first = records[0];

    if (first === undefined) {
      throw new Error("Missing inserted memory.");
    }

    await manager.update({
      context,
      expectedRevision: first.revision,
      id: first.id,
      patch: {
        metadata: {
          changed: true,
        },
      },
    });
    expect(provider.embed).toHaveBeenCalledTimes(2);

    await expect(
      manager.recall({
        context,
        query: "first",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        reasons: expect.arrayContaining(["SEMANTIC_MATCH"]),
      }),
      expect.any(Object),
    ]);
  });

  it("retries failed initialization and shares concurrent initialization", async () => {
    class FlakyStore extends InMemoryMemoryStore {
      public calls = 0;

      public override async initialize(options: { readonly signal?: AbortSignal } = {}) {
        this.calls += 1;

        if (this.calls === 1) {
          throw new Error("first failed");
        }

        return super.initialize(options);
      }
    }

    const store = new FlakyStore();
    const manager = createManager({ store });
    const request = {
      content: "retry",
      context,
      kind: "fact" as const,
    };

    await expect(manager.remember(request)).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(manager.remember(request)).resolves.toBeDefined();
    expect(store.calls).toBe(2);

    const sharedStore = new InMemoryMemoryStore();
    const initialize = vi.spyOn(sharedStore, "initialize");
    const shared = createManager({ store: sharedStore });
    await Promise.all([
      shared.remember({ ...request, content: "one" }),
      shared.remember({ ...request, content: "two" }),
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("propagates aborts and validates public operation inputs", async () => {
    const manager = createManager();
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.remember({
        content: "aborted",
        context,
        kind: "fact",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(MemoryAbortError);
    await expect(
      manager.recall({
        context,
        limit: 0,
        query: "query",
      }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
    await expect(
      manager.update({
        context,
        expectedRevision: 1,
        id: "missing",
        patch: {},
      }),
    ).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await expect(
      manager.prune({
        before: "invalid",
        context,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_DATE" });
  });

  it("supports idempotent writes and reports invalid Store responses", async () => {
    const manager = createManager();
    const request = {
      content: "idempotent",
      context: {
        namespace: "tenant",
      },
      idempotencyKey: "request-1",
      kind: "fact" as const,
    };
    const first = await manager.remember(request);

    await expect(manager.remember(request)).resolves.toEqual(first);
    await expect(
      manager.remember({
        ...request,
        content: "different",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });

    class EmptyWriteStore extends InMemoryMemoryStore {
      public override async rememberMany(): Promise<readonly never[]> {
        return [];
      }
    }

    await expect(
      createManager({ store: new EmptyWriteStore() }).remember({
        content: "missing",
        context,
        kind: "fact",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_STORE_UNAVAILABLE" });
  });

  it("covers empty extraction, optional draft fields, and extractor aborts", async () => {
    const lowConfidence = createManager({
      extractor: {
        async extract() {
          return [
            {
              confidence: 0.1,
              content: "discard",
              importance: 0.1,
              kind: "fact",
            },
          ];
        },
      },
    });
    await expect(
      lowConfidence.ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).resolves.toEqual({
      discarded: 1,
      extracted: 1,
      memories: [],
    });

    const completeDraft = createManager({
      extractor: {
        async extract() {
          return [
            {
              confidence: 1,
              content: "complete",
              expiresAt: "2027-01-01T00:00:00.000Z",
              importance: 1,
              kind: "decision",
              metadata: { source: "test" },
              tags: ["complete"],
            },
          ];
        },
      },
    });
    await expect(
      completeDraft.ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).resolves.toMatchObject({
      memories: [
        {
          expiresAt: "2027-01-01T00:00:00.000Z",
          metadata: { source: "test" },
          tags: ["complete"],
        },
      ],
    });

    const aborted = createManager({
      extractor: {
        async extract() {
          throw new MemoryAbortError("ingest");
        },
      },
    });
    await expect(
      aborted.ingestSession({
        context,
        output: "output",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).rejects.toBeInstanceOf(MemoryAbortError);
  });

  it("passes recall filters, reports vector scan limits, and skips touches for empty results", async () => {
    const store = new InMemoryMemoryStore();
    const events: MemoryOperationEvent[] = [];
    const manager = createManager({ events, store });
    await manager.remember({
      content: "seed",
      context,
      kind: "fact",
    });
    const touch = vi.spyOn(store, "touch");
    vi.spyOn(store, "search").mockResolvedValue({
      lexical: [],
      vector: [],
      vectorScanExceeded: true,
    });

    await expect(
      manager.recall({
        context,
        kinds: ["fact", "fact"],
        maxChars: 100,
        query: "missing",
        tags: ["tag"],
      }),
    ).resolves.toEqual([]);
    expect(touch).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEMORY_VECTOR_SCAN_LIMIT",
          operation: "recall",
          phase: "end",
        }),
      ]),
    );
  });

  it("updates lexical records with explicit expiry and redacted content", async () => {
    const events: MemoryOperationEvent[] = [];
    const manager = createManager({ events });
    const inserted = await manager.remember({
      content: "initial",
      context,
      kind: "fact",
    });
    const metadataOnly = await manager.update({
      context,
      expectedRevision: inserted.revision,
      id: inserted.id,
      patch: {
        metadata: { changed: true },
      },
    });
    const updated = await manager.update({
      context,
      expectedRevision: metadataOnly.revision,
      id: metadataOnly.id,
      patch: {
        content: "secret=hidden-value",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });

    expect(updated).toMatchObject({
      content: "[REDACTED]",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MEMORY_CONTENT_REDACTED",
          operation: "update",
        }),
      ]),
    );
    await expect(
      manager.forget({
        context,
        id: "missing",
      }),
    ).resolves.toBe(false);
  });

  it("rejects invalid retention, identifiers, and session text", async () => {
    const invalidRetention = createManager({
      policy: new DefaultMemoryPolicy({
        defaultRetentionMs: {
          fact: -1,
        },
      }),
    });
    await expect(
      invalidRetention.remember({
        content: "retention",
        context,
        kind: "fact",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_DATE" });

    const manager = createManager({
      extractor: {
        async extract() {
          return [];
        },
      },
    });
    await expect(manager.get({ context, id: "" })).rejects.toBeInstanceOf(MemoryValidationError);
    await expect(
      manager.forget({
        context,
        id: "x".repeat(257),
      }),
    ).rejects.toThrow("exceeds");
    await expect(
      manager.ingestSession({
        context,
        output: "",
        prompt: "prompt",
        sessionId: "session",
      }),
    ).rejects.toThrow("Session output");
    await expect(
      manager.ingestSession({
        context,
        output: "output",
        prompt: "",
        sessionId: "session",
      }),
    ).rejects.toThrow("Session prompt");
  });

  it("wraps strict provider failures for writes and queries", async () => {
    const writeFailure = createManager({
      embeddingProvider: embeddingProvider(() => {
        throw new Error("write provider failed");
      }),
      policy: new DefaultMemoryPolicy({
        embeddingFailureMode: "error",
      }),
    });
    await expect(
      writeFailure.remember({
        content: "write",
        context,
        kind: "fact",
      }),
    ).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_FAILED",
      cause: expect.objectContaining({ message: "write provider failed" }),
    });

    const queryProvider = embeddingProvider(() => [1, 0]);
    const queryFailure = createManager({
      embeddingProvider: queryProvider,
      policy: new DefaultMemoryPolicy({
        embeddingFailureMode: "error",
      }),
    });
    await queryFailure.remember({
      content: "query",
      context,
      kind: "fact",
    });
    queryProvider.embed.mockRejectedValueOnce(new Error("query provider failed"));
    await expect(
      queryFailure.recall({
        context,
        query: "query",
      }),
    ).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_FAILED",
      cause: expect.objectContaining({ message: "query provider failed" }),
    });
  });

  it("uses default clock and ID generation and cleans up failed initialization during close", async () => {
    const defaults = new MemoryManager({
      store: new InMemoryMemoryStore(),
    });
    const inserted = await defaults.remember({
      content: "defaults",
      context: {
        namespace: "tenant",
      },
      kind: "fact",
    });

    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Number.isFinite(Date.parse(inserted.createdAt))).toBe(true);
    await defaults.close();

    let rejectInitialization: ((error: Error) => void) | undefined;
    class PendingStore extends InMemoryMemoryStore {
      public override async initialize(): Promise<void> {
        return new Promise((_resolve, reject) => {
          rejectInitialization = reject;
        });
      }
    }

    const pending = createManager({ store: new PendingStore() });
    const remembering = pending.remember({
      content: "pending",
      context,
      kind: "fact",
    });
    const closing = pending.close();
    rejectInitialization?.(new Error("initialization failed"));
    await expect(remembering).rejects.toBeInstanceOf(MemoryStoreError);
    await expect(closing).resolves.toBeUndefined();
  });

  it("emits linked runtime and deep memory atoms", async () => {
    const flow = new AtomicFlowRun({ runId: "memory-flow" });
    const manager = createManager();
    await manager.remember({
      atomicFlow: flow,
      content: "atomic memory",
      context,
      kind: "fact",
    });
    await manager.recall({
      atomicFlow: flow,
      context,
      query: "atomic",
    });

    expect(flow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "memory.write",
        "memory.recall",
        "memory.query-embedding",
        "memory.fts-search",
        "memory.vector-search",
        "memory.rerank",
        "memory.semantic",
      ]),
    );
  });
});

function createManager(
  options: {
    readonly embeddingProvider?: EmbeddingProvider;
    readonly events?: MemoryOperationEvent[];
    readonly extractor?: MemoryExtractor;
    readonly policy?: DefaultMemoryPolicy;
    readonly store?: MemoryStore;
  } = {},
): MemoryManager {
  let id = 0;

  return new MemoryManager({
    clock: {
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    },
    ...(options.embeddingProvider !== undefined
      ? { embeddingProvider: options.embeddingProvider }
      : {}),
    ...(options.extractor !== undefined ? { extractor: options.extractor } : {}),
    idGenerator: () => {
      id += 1;
      return `memory-${id}`;
    },
    ...(options.events !== undefined
      ? {
          onEvent: (event) => options.events?.push(event),
        }
      : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    store: options.store ?? new InMemoryMemoryStore(),
  });
}

function embeddingProvider(
  resolve: (text: string) => readonly number[],
): EmbeddingProvider & { readonly embed: ReturnType<typeof vi.fn> } {
  return {
    dimensions: 2,
    embed: vi.fn(async (texts: readonly string[]) => texts.map(resolve)),
    model: "test",
  };
}
