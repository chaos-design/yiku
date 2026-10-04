import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMigrationError, MemoryStoreError } from "../../src/errors.js";
import { MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "../../src/stores/sqlite-schema.js";
import { SqliteMemoryStore } from "../../src/stores/sqlite-store.js";
import { runMemoryStoreConformance } from "./store-conformance.test.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

runMemoryStoreConformance("sqlite", () => {
  const directory = createTempDir();
  return new SqliteMemoryStore({
    filePath: join(directory, "memories.sqlite"),
  });
});

describe("SqliteMemoryStore", () => {
  it("persists records across Store instances and creates the current schema", async () => {
    const filePath = join(createTempDir(), "nested", "memories.sqlite");
    const first = new SqliteMemoryStore({ filePath });
    await first.initialize();
    await first.rememberMany([
      {
        accessCount: 0,
        confidence: 0.8,
        content: "persistent memory",
        createdAt: "2026-07-31T00:00:00.000Z",
        fingerprint: "persistent",
        id: "persistent",
        importance: 0.7,
        kind: "fact",
        metadata: {},
        namespace: "tenant",
        normalizedContent: "persistent memory",
        revision: 1,
        scope: {},
        scopeKey: "{}",
        source: { type: "user" },
        status: "active",
        tags: [],
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    ]);
    await first.close();

    const database = new DatabaseSync(filePath);
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: MEMORY_SCHEMA_VERSION,
    });
    database.close();

    const reopened = new SqliteMemoryStore({ filePath });
    await reopened.initialize();
    await expect(
      reopened.get({ context: { namespace: "tenant" }, id: "persistent" }),
    ).resolves.toMatchObject({
      content: "persistent memory",
    });
    await reopened.close();
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects newer database schemas without mutating them", async () => {
    const filePath = join(createTempDir(), "newer.sqlite");
    const database = new DatabaseSync(filePath);
    database.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION + 1}`);
    database.close();
    const store = new SqliteMemoryStore({ filePath });

    await expect(store.initialize()).rejects.toBeInstanceOf(MemoryMigrationError);
    await expect(store.initialize()).rejects.toMatchObject({
      code: "MEMORY_SCHEMA_NEWER_THAN_RUNTIME",
    });
    await store.close();
  });

  it("validates constructor options", () => {
    expect(() => new SqliteMemoryStore({ filePath: "relative.sqlite" })).toThrow(MemoryStoreError);
    expect(
      () =>
        new SqliteMemoryStore({
          busyTimeoutMs: -1,
          filePath: ":memory:",
        }),
    ).toThrow("busy timeout");
    expect(
      () =>
        new SqliteMemoryStore({
          busyTimeoutMs: 60_001,
          filePath: ":memory:",
        }),
    ).toThrow("busy timeout");
  });

  it("rejects invalid schema versions and rolls back migration failures", () => {
    const invalidVersion = {
      prepare: () => ({
        get: () => ({
          user_version: "invalid",
        }),
      }),
    } as unknown as DatabaseSync;
    expect(() => migrateMemorySchema(invalidVersion)).toThrow("invalid schema version");

    const exec = vi.fn((sql: string) => {
      if (sql.includes("CREATE TABLE") || sql === "ROLLBACK") {
        throw new Error("database failure");
      }
    });
    const failingMigration = {
      exec,
      prepare: () => ({
        get: () => ({
          user_version: 0,
        }),
      }),
    } as unknown as DatabaseSync;

    expect(() => migrateMemorySchema(failingMigration)).toThrow(MemoryMigrationError);
    expect(exec).toHaveBeenCalledWith("ROLLBACK");
  });

  it("initializes idempotently in memory", async () => {
    const store = new SqliteMemoryStore({
      busyTimeoutMs: 0,
      filePath: ":memory:",
    });

    await expect(store.initialize()).resolves.toBeUndefined();
    await expect(store.initialize()).resolves.toBeUndefined();
    await store.close();
  });
});

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "yiku-memories-"));
  mkdirSync(directory, { recursive: true });
  tempDirs.push(directory);
  return directory;
}
