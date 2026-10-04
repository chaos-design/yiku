import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { MemoryConflictError, MemoryError, MemoryStoreError, throwIfAborted } from "../errors.js";
import { cosineSimilarity } from "../retrieval/default-reranker.js";
import type {
  JsonValue,
  MemoryCandidateSet,
  MemoryContext,
  MemoryEmbedding,
  MemoryKind,
  MemoryKindCounts,
  MemoryScope,
  MemorySource,
  MemoryStatus,
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
  SqliteMemoryStoreOptions,
  StoredMemory,
  StoredMemoryWrite,
} from "../types.js";
import { migrateMemorySchema } from "./sqlite-schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);

const INSERT_SQL = `
  INSERT INTO memories (
    id, namespace, scope_key, user_id, agent_id, project_id, session_id, kind, content,
    normalized_content, fingerprint, tags_json, metadata_json, source_type, source_id,
    confidence, importance, status, created_at, updated_at, last_accessed_at, expires_at,
    revision, access_count, idempotency_key, idempotency_hash, embedding, embedding_model,
    embedding_dimensions
  ) VALUES (
    $id, $namespace, $scopeKey, $userId, $agentId, $projectId, $sessionId, $kind, $content,
    $normalizedContent, $fingerprint, $tagsJson, $metadataJson, $sourceType, $sourceId,
    $confidence, $importance, $status, $createdAt, $updatedAt, $lastAccessedAt, $expiresAt,
    $revision, $accessCount, $idempotencyKey, $idempotencyHash, $embedding, $embeddingModel,
    $embeddingDimensions
  )
`;

const UPDATE_SQL = `
  UPDATE memories SET
    namespace = $namespace,
    scope_key = $scopeKey,
    user_id = $userId,
    agent_id = $agentId,
    project_id = $projectId,
    session_id = $sessionId,
    kind = $kind,
    content = $content,
    normalized_content = $normalizedContent,
    fingerprint = $fingerprint,
    tags_json = $tagsJson,
    metadata_json = $metadataJson,
    source_type = $sourceType,
    source_id = $sourceId,
    confidence = $confidence,
    importance = $importance,
    status = $status,
    created_at = $createdAt,
    updated_at = $updatedAt,
    last_accessed_at = $lastAccessedAt,
    expires_at = $expiresAt,
    revision = $revision,
    access_count = $accessCount,
    idempotency_key = $idempotencyKey,
    idempotency_hash = $idempotencyHash,
    embedding = $embedding,
    embedding_model = $embeddingModel,
    embedding_dimensions = $embeddingDimensions
  WHERE id = $id
`;

interface SqlFilter {
  readonly parameters: readonly SQLInputValue[];
  readonly sql: string;
}

export class SqliteMemoryStore implements MemoryStore {
  private closed = false;
  private database: DatabaseSync | undefined;
  private initialized = false;
  private readonly busyTimeoutMs: number;
  private readonly filePath: string;

  public constructor(options: SqliteMemoryStoreOptions) {
    if (
      typeof options.filePath !== "string" ||
      !options.filePath.trim() ||
      (options.filePath !== ":memory:" && !isAbsolute(options.filePath))
    ) {
      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "SQLite memory file path must be absolute or :memory:.",
      );
    }

    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "SQLite busy timeout must be an integer between 0 and 60000.",
      );
    }

    this.busyTimeoutMs = busyTimeoutMs;
    this.filePath = options.filePath;
  }

  public async initialize(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal, "initialize");
    this.ensureOpen();

    if (this.initialized) {
      return;
    }

    const existed = this.filePath === ":memory:" || existsSync(this.filePath);

    try {
      if (this.filePath !== ":memory:") {
        mkdirSync(dirname(this.filePath), { recursive: true });
      }

      const database = openDatabase(this.filePath);
      this.database = database;
      database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
      database.exec("PRAGMA temp_store = MEMORY");
      migrateMemorySchema(database);
      throwIfAborted(options.signal, "initialize");
      this.initialized = true;

      if (!existed && this.filePath !== ":memory:") {
        setPrivateFileMode(this.filePath);
      }
    } catch (error) {
      this.closeDatabase();

      if (error instanceof MemoryError) {
        throw error;
      }

      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "Failed to initialize the SQLite memory Store.",
        { cause: error, operation: "initialize" },
      );
    }
  }

  public async rememberMany(
    inputs: readonly StoredMemoryWrite[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly StoredMemory[]> {
    throwIfAborted(options.signal, "remember");

    return this.execute("remember", (database) =>
      transaction(database, () => {
        const results = inputs.map((input) => rememberOne(database, input));
        throwIfAborted(options.signal, "remember");
        return results;
      }),
    );
  }

  public async get(input: MemoryStoreGetInput): Promise<StoredMemory | undefined> {
    throwIfAborted(input.signal);

    return this.execute("recall", (database) => {
      const scope = scopeFilter(input.context);
      const row = database
        .prepare(`SELECT * FROM memories WHERE id = ? AND status = 'active' AND ${scope.sql}`)
        .get(input.id, ...scope.parameters);

      return row === undefined ? undefined : rowToMemory(row);
    });
  }

  public async update(input: MemoryStoreUpdateInput): Promise<StoredMemory> {
    throwIfAborted(input.signal, "update");

    return this.execute("update", (database) =>
      transaction(database, () => {
        const scope = scopeFilter(input.context);
        const row = database
          .prepare(`SELECT * FROM memories WHERE id = ? AND status = 'active' AND ${scope.sql}`)
          .get(input.memory.id, ...scope.parameters);

        if (row === undefined) {
          throw new MemoryStoreError("MEMORY_NOT_FOUND", "Memory record was not found.", {
            operation: "update",
          });
        }

        const current = rowToMemory(row);

        if (current.revision !== input.expectedRevision) {
          throw new MemoryConflictError(
            "MEMORY_REVISION_CONFLICT",
            "Memory revision does not match the expected revision.",
            { operation: "update" },
          );
        }

        const duplicate = findDuplicate(database, input.memory, current.id);

        if (duplicate !== undefined) {
          throw new MemoryConflictError(
            "MEMORY_IDEMPOTENCY_CONFLICT",
            "Memory update conflicts with an existing record.",
            { operation: "update" },
          );
        }

        const updated: StoredMemory = {
          ...input.memory,
          createdAt: current.createdAt,
          id: current.id,
          revision: current.revision + 1,
        };
        updateMemory(database, updated);
        syncFts(database, updated);
        return updated;
      }),
    );
  }

  public async search(input: MemoryStoreSearchInput): Promise<MemoryCandidateSet> {
    throwIfAborted(input.signal, "recall");

    return this.execute("recall", (database) => {
      const filter = searchFilter(input, "m");
      const lexical = searchLexical(database, input, filter);
      const vector = searchVector(database, input, filter);

      return {
        lexical,
        vector: vector.results,
        vectorScanExceeded: vector.exceeded,
      };
    });
  }

  public async touch(input: MemoryStoreTouchInput): Promise<void> {
    throwIfAborted(input.signal, "recall");

    this.execute("recall", (database) =>
      transaction(database, () => {
        const scope = scopeFilter(input.context);
        const statement = database.prepare(`
          UPDATE memories
          SET access_count = access_count + 1, last_accessed_at = ?
          WHERE id = ? AND status = 'active' AND ${scope.sql}
        `);

        for (const id of new Set(input.ids)) {
          statement.run(input.touchedAt, id, ...scope.parameters);
        }
      }),
    );
  }

  public async forget(input: MemoryStoreForgetInput): Promise<boolean> {
    throwIfAborted(input.signal, "forget");

    return this.execute("forget", (database) =>
      transaction(database, () => {
        const scope = scopeFilter(input.context);
        const row = database
          .prepare(`SELECT * FROM memories WHERE id = ? AND ${scope.sql}`)
          .get(input.id, ...scope.parameters);

        if (row === undefined) {
          return false;
        }

        const memory = rowToMemory(row);

        if (input.mode === "hard") {
          deleteMemory(database, memory.id);
          return true;
        }

        if (memory.status !== "active") {
          return false;
        }

        const deleted: StoredMemory = {
          ...memory,
          revision: memory.revision + 1,
          status: "deleted",
          updatedAt: input.updatedAt,
        };
        updateMemory(database, deleted);
        syncFts(database, deleted);
        return true;
      }),
    );
  }

  public async prune(input: MemoryStorePruneInput): Promise<MemoryStorePruneResult> {
    throwIfAborted(input.signal, "prune");

    return this.execute("prune", (database) =>
      transaction(database, () => {
        const scope = scopeFilter(input.context);
        const rows = database
          .prepare(`
            SELECT id FROM memories
            WHERE ${scope.sql}
              AND (
                (expires_at IS NOT NULL AND expires_at <= ?)
                OR (status = 'deleted' AND updated_at <= ?)
              )
          `)
          .all(...scope.parameters, input.now, input.before);

        for (const row of rows) {
          deleteMemory(database, stringColumn(row, "id"));
        }

        return { deleted: rows.length };
      }),
    );
  }

  public async countByKind(input: MemoryStoreCountInput): Promise<MemoryKindCounts> {
    throwIfAborted(input.signal, "search");
    return this.execute("search", (database) => {
      const scope = scopeFilter(input.context);
      const rows = database
        .prepare(`
          SELECT kind, COUNT(*) AS count
          FROM memories
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > ?)
            AND ${scope.sql}
          GROUP BY kind
        `)
        .all(input.now, ...scope.parameters);
      const counts: Record<MemoryKind, number> = {
        decision: 0,
        episode: 0,
        fact: 0,
        preference: 0,
        procedure: 0,
      };
      for (const row of rows) {
        counts[stringColumn(row, "kind") as MemoryKind] = numberColumn(row, "count");
      }
      return counts;
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.initialized = false;
    this.closeDatabase();
  }

  private execute<T>(
    operation: "forget" | "prune" | "recall" | "remember" | "search" | "update",
    fn: (database: DatabaseSync) => T,
  ): T {
    const database = this.ensureReady();

    try {
      return fn(database);
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error;
      }

      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        `SQLite memory ${operation} operation failed.`,
        { cause: error, operation },
      );
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new MemoryStoreError("MEMORY_STORE_CLOSED", "Memory Store is closed.");
    }
  }

  private ensureReady(): DatabaseSync {
    this.ensureOpen();

    if (!this.initialized || this.database === undefined) {
      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "Memory Store has not been initialized.",
      );
    }

    return this.database;
  }

  private closeDatabase(): void {
    const database = this.database;
    this.database = undefined;

    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // Closing remains idempotent from the Store caller's perspective.
      }
    }
  }
}

function openDatabase(filePath: string): DatabaseSync {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(filePath);
}

function rememberOne(database: DatabaseSync, input: StoredMemoryWrite): StoredMemory {
  const idempotent = findIdempotent(database, input);

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

  const duplicate = findDuplicate(database, input);

  if (duplicate !== undefined) {
    const merged = mergeDuplicate(duplicate, input);
    updateMemory(database, merged);
    syncFts(database, merged);
    return merged;
  }

  if (readMemory(database, "SELECT * FROM memories WHERE id = ?", [input.id]) !== undefined) {
    throw new MemoryConflictError("MEMORY_IDEMPOTENCY_CONFLICT", "Memory ID already exists.", {
      operation: "remember",
    });
  }

  insertMemory(database, input);
  syncFts(database, input);
  return input;
}

function findIdempotent(
  database: DatabaseSync,
  input: StoredMemoryWrite,
): StoredMemory | undefined {
  if (input.idempotencyKey === undefined) {
    return undefined;
  }

  return readMemory(
    database,
    "SELECT * FROM memories WHERE namespace = ? AND idempotency_key = ?",
    [input.namespace, input.idempotencyKey],
  );
}

function findDuplicate(
  database: DatabaseSync,
  input: StoredMemoryWrite,
  excludedId?: string,
): StoredMemory | undefined {
  const exclusion = excludedId === undefined ? "" : " AND id <> ?";
  const parameters: SQLInputValue[] = [
    input.namespace,
    input.scopeKey,
    input.kind,
    input.fingerprint,
    ...(excludedId === undefined ? [] : [excludedId]),
  ];

  return readMemory(
    database,
    `
      SELECT * FROM memories
      WHERE namespace = ? AND scope_key = ? AND kind = ? AND fingerprint = ?${exclusion}
    `,
    parameters,
  );
}

function mergeDuplicate(current: StoredMemory, input: StoredMemoryWrite): StoredMemory {
  return {
    ...current,
    ...(input.embedding !== undefined ? { embedding: input.embedding } : {}),
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
  };
}

function insertMemory(database: DatabaseSync, memory: StoredMemory): void {
  database.prepare(INSERT_SQL).run(memoryParameters(memory));
}

function updateMemory(database: DatabaseSync, memory: StoredMemory): void {
  database.prepare(UPDATE_SQL).run(memoryParameters(memory));
}

function syncFts(database: DatabaseSync, memory: StoredMemory): void {
  database.prepare("DELETE FROM memories_fts WHERE id = ?").run(memory.id);

  if (memory.status === "active") {
    database
      .prepare("INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)")
      .run(memory.id, memory.content, memory.tags.join(" "));
  }
}

function deleteMemory(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
  database.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

function searchLexical(
  database: DatabaseSync,
  input: MemoryStoreSearchInput,
  filter: SqlFilter,
): readonly RankedStoredMemory[] {
  const ftsQuery = createFtsQuery(input.query);

  if (!ftsQuery) {
    return [];
  }

  const rows = database
    .prepare(`
      SELECT m.*, bm25(memories_fts) AS lexical_score
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.id
      WHERE memories_fts MATCH ? AND ${filter.sql}
      ORDER BY lexical_score ASC, m.updated_at DESC, m.id ASC
      LIMIT ?
    `)
    .all(ftsQuery, ...filter.parameters, input.lexicalLimit);

  return rows.map((row, index) => ({
    memory: rowToMemory(row),
    rank: index + 1,
    score: 1 / (1 + Math.abs(numberColumn(row, "lexical_score"))),
  }));
}

function searchVector(
  database: DatabaseSync,
  input: MemoryStoreSearchInput,
  filter: SqlFilter,
): { readonly exceeded: boolean; readonly results: readonly RankedStoredMemory[] } {
  if (input.queryEmbedding === undefined || input.embeddingModel === undefined) {
    return { exceeded: false, results: [] };
  }

  const embeddingFilter = `
    ${filter.sql}
    AND m.embedding IS NOT NULL
    AND m.embedding_model = ?
    AND m.embedding_dimensions = ?
  `;
  const parameters = [...filter.parameters, input.embeddingModel, input.queryEmbedding.length];
  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM memories m WHERE ${embeddingFilter}`)
    .get(...parameters);
  const count = numberColumn(countRow, "count");

  if (count > input.vectorScanLimit) {
    return { exceeded: true, results: [] };
  }

  const rows = database
    .prepare(`
      SELECT m.* FROM memories m
      WHERE ${embeddingFilter}
      ORDER BY m.importance DESC, m.updated_at DESC, m.id ASC
      LIMIT ?
    `)
    .all(...parameters, input.vectorScanLimit);
  const scored = rows.flatMap((row) => {
    const memory = rowToMemory(row);

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

function searchFilter(input: MemoryStoreSearchInput, prefix: string): SqlFilter {
  const scope = scopeFilter(input.context, prefix);
  const sql = [
    scope.sql,
    `${prefix}.status = 'active'`,
    `(${prefix}.expires_at IS NULL OR ${prefix}.expires_at > ?)`,
  ];
  const parameters: SQLInputValue[] = [...scope.parameters, input.now];

  if (input.kinds !== undefined && input.kinds.length > 0) {
    sql.push(`${prefix}.kind IN (${input.kinds.map(() => "?").join(", ")})`);
    parameters.push(...input.kinds);
  }

  for (const tag of input.tags ?? []) {
    sql.push(`EXISTS (SELECT 1 FROM json_each(${prefix}.tags_json) WHERE value = ?)`);
    parameters.push(tag);
  }

  return {
    parameters,
    sql: sql.join(" AND "),
  };
}

function scopeFilter(context: MemoryContext, prefix?: string): SqlFilter {
  const columnPrefix = prefix ? `${prefix}.` : "";
  const scope = context.scope ?? {};

  return {
    parameters: [
      context.namespace,
      scope.userId ?? null,
      scope.agentId ?? null,
      scope.projectId ?? null,
      scope.sessionId ?? null,
    ],
    sql: [
      `${columnPrefix}namespace = ?`,
      `(${columnPrefix}user_id IS NULL OR ${columnPrefix}user_id = ?)`,
      `(${columnPrefix}agent_id IS NULL OR ${columnPrefix}agent_id = ?)`,
      `(${columnPrefix}project_id IS NULL OR ${columnPrefix}project_id = ?)`,
      `(${columnPrefix}session_id IS NULL OR ${columnPrefix}session_id = ?)`,
    ].join(" AND "),
  };
}

function createFtsQuery(query: string): string {
  return [
    ...new Set(
      query
        .normalize("NFC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    ),
  ]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function memoryParameters(memory: StoredMemory): Record<string, SQLInputValue> {
  return {
    $accessCount: memory.accessCount,
    $agentId: memory.scope.agentId ?? null,
    $confidence: memory.confidence,
    $content: memory.content,
    $createdAt: memory.createdAt,
    $embedding: memory.embedding === undefined ? null : encodeEmbedding(memory.embedding.values),
    $embeddingDimensions: memory.embedding?.dimensions ?? null,
    $embeddingModel: memory.embedding?.model ?? null,
    $expiresAt: memory.expiresAt ?? null,
    $fingerprint: memory.fingerprint,
    $id: memory.id,
    $idempotencyHash: memory.idempotencyHash ?? null,
    $idempotencyKey: memory.idempotencyKey ?? null,
    $importance: memory.importance,
    $kind: memory.kind,
    $lastAccessedAt: memory.lastAccessedAt ?? null,
    $metadataJson: JSON.stringify(memory.metadata),
    $namespace: memory.namespace,
    $normalizedContent: memory.normalizedContent,
    $projectId: memory.scope.projectId ?? null,
    $revision: memory.revision,
    $scopeKey: memory.scopeKey,
    $sessionId: memory.scope.sessionId ?? null,
    $sourceId: memory.source.id ?? null,
    $sourceType: memory.source.type,
    $status: memory.status,
    $tagsJson: JSON.stringify(memory.tags),
    $updatedAt: memory.updatedAt,
    $userId: memory.scope.userId ?? null,
  };
}

function rowToMemory(row: Record<string, unknown>): StoredMemory {
  const embeddingModel = nullableStringColumn(row, "embedding_model");
  const embeddingDimensions = nullableNumberColumn(row, "embedding_dimensions");
  const embeddingBytes = row.embedding;
  const embedding =
    embeddingModel !== undefined &&
    embeddingDimensions !== undefined &&
    embeddingBytes instanceof Uint8Array
      ? decodeEmbedding(embeddingBytes, embeddingModel, embeddingDimensions)
      : undefined;
  const expiresAt = nullableStringColumn(row, "expires_at");
  const lastAccessedAt = nullableStringColumn(row, "last_accessed_at");
  const idempotencyHash = nullableStringColumn(row, "idempotency_hash");
  const idempotencyKey = nullableStringColumn(row, "idempotency_key");

  return {
    accessCount: numberColumn(row, "access_count"),
    confidence: numberColumn(row, "confidence"),
    content: stringColumn(row, "content"),
    createdAt: stringColumn(row, "created_at"),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    fingerprint: stringColumn(row, "fingerprint"),
    id: stringColumn(row, "id"),
    ...(idempotencyHash !== undefined ? { idempotencyHash } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    importance: numberColumn(row, "importance"),
    kind: stringColumn(row, "kind") as MemoryKind,
    ...(lastAccessedAt !== undefined ? { lastAccessedAt } : {}),
    metadata: JSON.parse(stringColumn(row, "metadata_json")) as Readonly<Record<string, JsonValue>>,
    namespace: stringColumn(row, "namespace"),
    normalizedContent: stringColumn(row, "normalized_content"),
    revision: numberColumn(row, "revision"),
    scope: rowToScope(row),
    scopeKey: stringColumn(row, "scope_key"),
    source: rowToSource(row),
    status: stringColumn(row, "status") as MemoryStatus,
    tags: JSON.parse(stringColumn(row, "tags_json")) as readonly string[],
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function rowToScope(row: Record<string, unknown>): MemoryScope {
  const agentId = nullableStringColumn(row, "agent_id");
  const projectId = nullableStringColumn(row, "project_id");
  const sessionId = nullableStringColumn(row, "session_id");
  const userId = nullableStringColumn(row, "user_id");

  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(userId !== undefined ? { userId } : {}),
  };
}

function rowToSource(row: Record<string, unknown>): MemorySource {
  const id = nullableStringColumn(row, "source_id");

  return {
    ...(id !== undefined ? { id } : {}),
    type: stringColumn(row, "source_type") as MemorySource["type"],
  };
}

function encodeEmbedding(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);

  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }

  return buffer;
}

function decodeEmbedding(bytes: Uint8Array, model: string, dimensions: number): MemoryEmbedding {
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new MemoryStoreError(
      "MEMORY_STORE_UNAVAILABLE",
      "Stored memory embedding has an invalid byte length.",
    );
  }

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({ length: dimensions }, (_, index) =>
    buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT),
  );

  return {
    dimensions,
    model,
    values,
  };
}

function readMemory(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[],
): StoredMemory | undefined {
  const row = database.prepare(sql).get(...parameters);
  return row === undefined ? undefined : rowToMemory(row);
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled the transaction back.
    }

    throw error;
  }
}

function stringColumn(row: Record<string, unknown> | undefined, name: string): string {
  const value = row?.[name];

  if (typeof value !== "string") {
    throw new MemoryStoreError(
      "MEMORY_STORE_UNAVAILABLE",
      `SQLite memory column ${name} is not a string.`,
    );
  }

  return value;
}

function nullableStringColumn(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name];

  if (value === null || value === undefined) {
    return undefined;
  }

  return stringColumn(row, name);
}

function numberColumn(row: Record<string, unknown> | undefined, name: string): number {
  const value = row?.[name];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MemoryStoreError(
      "MEMORY_STORE_UNAVAILABLE",
      `SQLite memory column ${name} is not a finite number.`,
    );
  }

  return value;
}

function nullableNumberColumn(row: Record<string, unknown>, name: string): number | undefined {
  const value = row[name];

  if (value === null || value === undefined) {
    return undefined;
  }

  return numberColumn(row, name);
}

function setPrivateFileMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // POSIX modes are unavailable on some file systems.
  }
}
