import type { DatabaseSync } from "node:sqlite";
import { MemoryMigrationError } from "../errors.js";

export const MEMORY_SCHEMA_VERSION = 1;

const CREATE_SCHEMA_SQL = `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    user_id TEXT,
    agent_id TEXT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'episode', 'fact', 'preference', 'procedure')),
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('import', 'session', 'tool', 'user')),
    source_id TEXT,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT,
    expires_at TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    access_count INTEGER NOT NULL CHECK (access_count >= 0),
    idempotency_key TEXT,
    idempotency_hash TEXT,
    embedding BLOB,
    embedding_model TEXT,
    embedding_dimensions INTEGER CHECK (
      embedding_dimensions IS NULL OR embedding_dimensions > 0
    ),
    UNIQUE (namespace, scope_key, kind, fingerprint)
  );

  CREATE UNIQUE INDEX memories_idempotency
    ON memories(namespace, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE INDEX memories_scope
    ON memories(namespace, status, user_id, agent_id, project_id, session_id);

  CREATE INDEX memories_retention
    ON memories(namespace, status, expires_at, updated_at);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    id UNINDEXED,
    content,
    tags,
    tokenize = 'unicode61'
  );
`;

export function migrateMemorySchema(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get();
  const version = Number(row?.user_version ?? 0);

  if (!Number.isSafeInteger(version) || version < 0) {
    throw new MemoryMigrationError(
      "MEMORY_MIGRATION_FAILED",
      "Memory database contains an invalid schema version.",
    );
  }

  if (version > MEMORY_SCHEMA_VERSION) {
    throw new MemoryMigrationError(
      "MEMORY_SCHEMA_NEWER_THAN_RUNTIME",
      `Memory database schema ${version} is newer than supported version ${MEMORY_SCHEMA_VERSION}.`,
    );
  }

  if (version === MEMORY_SCHEMA_VERSION) {
    return;
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(CREATE_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);

    throw new MemoryMigrationError(
      "MEMORY_MIGRATION_FAILED",
      "Failed to migrate the memory database.",
      { cause: error },
    );
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may already have been rolled back by SQLite.
  }
}
