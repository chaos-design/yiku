import { MemoryConflictError, MemoryStoreError, throwIfAborted } from "../errors.js";
import { cosineSimilarity } from "../retrieval/default-reranker.js";
import type {
  MemoryCandidateSet,
  MemoryContext,
  MemoryKindCounts,
  MemoryStore,
  MemoryStoreCountInput,
  MemoryStoreForgetInput,
  MemoryStoreGetInput,
  MemoryStorePruneInput,
  MemoryStorePruneResult,
  MemoryStoreSearchInput,
  MemoryStoreTouchInput,
  MemoryStoreUpdateInput,
  RankedStoredMemory,
  StoredMemory,
  StoredMemoryWrite,
} from "../types.js";

export class InMemoryMemoryStore implements MemoryStore {
  private closed = false;
  private initialized = false;
  private records = new Map<string, StoredMemory>();

  public async initialize(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal, "initialize");
    this.ensureOpen();
    this.initialized = true;
  }

  public async rememberMany(
    inputs: readonly StoredMemoryWrite[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly StoredMemory[]> {
    throwIfAborted(options.signal, "remember");
    this.ensureReady();
    const next = cloneMap(this.records);
    const results = inputs.map((input) => rememberOne(next, input));
    throwIfAborted(options.signal, "remember");
    this.records = next;

    return results.map(cloneMemory);
  }

  public async get(input: MemoryStoreGetInput): Promise<StoredMemory | undefined> {
    throwIfAborted(input.signal);
    this.ensureReady();
    const memory = this.records.get(input.id);

    return memory !== undefined && memory.status === "active" && isApplicable(memory, input.context)
      ? cloneMemory(memory)
      : undefined;
  }

  public async update(input: MemoryStoreUpdateInput): Promise<StoredMemory> {
    throwIfAborted(input.signal, "update");
    this.ensureReady();
    const current = this.records.get(input.memory.id);

    if (
      current === undefined ||
      current.status !== "active" ||
      !isApplicable(current, input.context)
    ) {
      throw new MemoryStoreError("MEMORY_NOT_FOUND", "Memory record was not found.", {
        operation: "update",
      });
    }

    if (current.revision !== input.expectedRevision) {
      throw new MemoryConflictError(
        "MEMORY_REVISION_CONFLICT",
        "Memory revision does not match the expected revision.",
        { operation: "update" },
      );
    }

    const duplicate = findDuplicate(this.records, input.memory, current.id);

    if (duplicate !== undefined) {
      throw new MemoryConflictError(
        "MEMORY_IDEMPOTENCY_CONFLICT",
        "Memory update conflicts with an existing record.",
        { operation: "update" },
      );
    }

    const updated = cloneMemory({
      ...input.memory,
      createdAt: current.createdAt,
      id: current.id,
      revision: current.revision + 1,
    });
    this.records.set(updated.id, updated);

    return cloneMemory(updated);
  }

  public async search(input: MemoryStoreSearchInput): Promise<MemoryCandidateSet> {
    throwIfAborted(input.signal, "recall");
    this.ensureReady();
    const eligible = [...this.records.values()].filter((memory) => matchesSearch(memory, input));
    const lexical = lexicalCandidates(eligible, input.query, input.lexicalLimit);
    const vectorResult = vectorCandidates(eligible, input);

    return {
      lexical: lexical.map(cloneRankedMemory),
      vector: vectorResult.results.map(cloneRankedMemory),
      vectorScanExceeded: vectorResult.exceeded,
    };
  }

  public async touch(input: MemoryStoreTouchInput): Promise<void> {
    throwIfAborted(input.signal, "recall");
    this.ensureReady();

    for (const id of new Set(input.ids)) {
      const memory = this.records.get(id);

      if (memory?.status === "active" && isApplicable(memory, input.context)) {
        this.records.set(id, {
          ...memory,
          accessCount: memory.accessCount + 1,
          lastAccessedAt: input.touchedAt,
        });
      }
    }
  }

  public async forget(input: MemoryStoreForgetInput): Promise<boolean> {
    throwIfAborted(input.signal, "forget");
    this.ensureReady();
    const memory = this.records.get(input.id);

    if (memory === undefined || !isApplicable(memory, input.context)) {
      return false;
    }

    if (input.mode === "hard") {
      return this.records.delete(input.id);
    }

    if (memory.status !== "active") {
      return false;
    }

    this.records.set(input.id, {
      ...memory,
      revision: memory.revision + 1,
      status: "deleted",
      updatedAt: input.updatedAt,
    });

    return true;
  }

  public async prune(input: MemoryStorePruneInput): Promise<MemoryStorePruneResult> {
    throwIfAborted(input.signal, "prune");
    this.ensureReady();
    let deleted = 0;

    for (const [id, memory] of this.records) {
      if (
        isApplicable(memory, input.context) &&
        ((memory.expiresAt !== undefined && memory.expiresAt <= input.now) ||
          (memory.status === "deleted" && memory.updatedAt <= input.before))
      ) {
        this.records.delete(id);
        deleted += 1;
      }
    }

    return { deleted };
  }

  public async countByKind(input: MemoryStoreCountInput): Promise<MemoryKindCounts> {
    throwIfAborted(input.signal, "search");
    this.ensureReady();
    const counts = {
      decision: 0,
      episode: 0,
      fact: 0,
      preference: 0,
      procedure: 0,
    };
    for (const memory of this.records.values()) {
      if (
        memory.status === "active" &&
        isApplicable(memory, input.context) &&
        (memory.expiresAt === undefined || memory.expiresAt > input.now)
      ) {
        counts[memory.kind] += 1;
      }
    }
    return counts;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new MemoryStoreError("MEMORY_STORE_CLOSED", "Memory Store is closed.");
    }
  }

  private ensureReady(): void {
    this.ensureOpen();

    if (!this.initialized) {
      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "Memory Store has not been initialized.",
      );
    }
  }
}

function rememberOne(records: Map<string, StoredMemory>, input: StoredMemoryWrite): StoredMemory {
  const idempotent = findIdempotent(records, input);

  if (idempotent !== undefined) {
    if (idempotent.idempotencyHash !== input.idempotencyHash) {
      throw new MemoryConflictError(
        "MEMORY_IDEMPOTENCY_CONFLICT",
        "Memory idempotency key was reused with different content.",
        { operation: "remember" },
      );
    }

    return idempotent;
  }

  const duplicate = findDuplicate(records, input);

  if (duplicate !== undefined) {
    const merged = mergeDuplicate(duplicate, input);
    records.set(merged.id, merged);
    return merged;
  }

  if (records.has(input.id)) {
    throw new MemoryConflictError("MEMORY_IDEMPOTENCY_CONFLICT", "Memory ID already exists.", {
      operation: "remember",
    });
  }

  const inserted = cloneMemory(input);
  records.set(inserted.id, inserted);
  return inserted;
}

function findIdempotent(
  records: ReadonlyMap<string, StoredMemory>,
  input: StoredMemoryWrite,
): StoredMemory | undefined {
  if (input.idempotencyKey === undefined) {
    return undefined;
  }

  return [...records.values()].find(
    (memory) =>
      memory.namespace === input.namespace && memory.idempotencyKey === input.idempotencyKey,
  );
}

function findDuplicate(
  records: ReadonlyMap<string, StoredMemory>,
  input: StoredMemoryWrite,
  excludedId?: string,
): StoredMemory | undefined {
  return [...records.values()].find(
    (memory) =>
      memory.id !== excludedId &&
      memory.namespace === input.namespace &&
      memory.scopeKey === input.scopeKey &&
      memory.kind === input.kind &&
      memory.fingerprint === input.fingerprint,
  );
}

function mergeDuplicate(current: StoredMemory, input: StoredMemoryWrite): StoredMemory {
  return cloneMemory({
    ...current,
    ...(input.embedding !== undefined
      ? {
          embedding: input.embedding,
        }
      : {}),
    confidence: Math.max(current.confidence, input.confidence),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : { expiresAt: undefined }),
    idempotencyHash: input.idempotencyHash ?? current.idempotencyHash,
    idempotencyKey: input.idempotencyKey ?? current.idempotencyKey,
    importance: Math.max(current.importance, input.importance),
    metadata: {
      ...current.metadata,
      ...input.metadata,
    },
    revision: current.revision + 1,
    source: input.source,
    status: "active",
    tags: [...new Set([...current.tags, ...input.tags])].sort(),
    updatedAt: input.updatedAt,
  });
}

function matchesSearch(memory: StoredMemory, input: MemoryStoreSearchInput): boolean {
  return (
    memory.status === "active" &&
    isApplicable(memory, input.context) &&
    (memory.expiresAt === undefined || memory.expiresAt > input.now) &&
    (input.kinds === undefined || input.kinds.includes(memory.kind)) &&
    (input.tags === undefined || input.tags.every((tag) => memory.tags.includes(tag)))
  );
}

function lexicalCandidates(
  memories: readonly StoredMemory[],
  query: string,
  limit: number,
): readonly RankedStoredMemory[] {
  const terms = tokenize(query);

  return memories
    .map((memory) => ({
      memory,
      score: lexicalScore(memory, terms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
        left.memory.id.localeCompare(right.memory.id),
    )
    .slice(0, limit)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
}

function vectorCandidates(
  memories: readonly StoredMemory[],
  input: MemoryStoreSearchInput,
): { readonly exceeded: boolean; readonly results: readonly RankedStoredMemory[] } {
  if (input.queryEmbedding === undefined || input.embeddingModel === undefined) {
    return { exceeded: false, results: [] };
  }

  const embedded = memories.filter((memory) => {
    const embedding = memory.embedding;

    return (
      embedding !== undefined &&
      embedding.model === input.embeddingModel &&
      embedding.dimensions === input.queryEmbedding?.length
    );
  });

  if (embedded.length > input.vectorScanLimit) {
    return { exceeded: true, results: [] };
  }

  const scored = embedded.flatMap((memory) => {
    try {
      return [
        {
          memory,
          score: cosineSimilarity(memory.embedding?.values ?? [], input.queryEmbedding ?? []),
        },
      ];
    } catch {
      return [];
    }
  });

  return {
    exceeded: false,
    results: scored
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, input.vectorLimit)
      .map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
      })),
  };
}

function lexicalScore(memory: StoredMemory, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 0;
  }

  const text = `${memory.normalizedContent} ${memory.tags.join(" ")}`.toLocaleLowerCase();
  const matches = terms.filter((term) => text.includes(term)).length;

  return matches / terms.length;
}

function tokenize(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .normalize("NFC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    ),
  ];
}

function isApplicable(memory: StoredMemory, context: MemoryContext): boolean {
  if (memory.namespace !== context.namespace) {
    return false;
  }

  const queryScope = context.scope ?? {};

  return (
    matchesScopeValue(memory.scope.agentId, queryScope.agentId) &&
    matchesScopeValue(memory.scope.projectId, queryScope.projectId) &&
    matchesScopeValue(memory.scope.sessionId, queryScope.sessionId) &&
    matchesScopeValue(memory.scope.userId, queryScope.userId)
  );
}

function matchesScopeValue(
  recordValue: string | undefined,
  queryValue: string | undefined,
): boolean {
  return recordValue === undefined || recordValue === queryValue;
}

function cloneMap(records: ReadonlyMap<string, StoredMemory>): Map<string, StoredMemory> {
  return new Map([...records].map(([id, memory]) => [id, cloneMemory(memory)]));
}

function cloneMemory(memory: StoredMemory): StoredMemory {
  return structuredClone(memory);
}

function cloneRankedMemory(memory: RankedStoredMemory): RankedStoredMemory {
  return {
    ...memory,
    memory: cloneMemory(memory.memory),
  };
}
