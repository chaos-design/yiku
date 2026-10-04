import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLockManager, sha256Text } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("FileLockManager", () => {
  it("excludes concurrent owners and supports idempotent release", async () => {
    const lockDir = await temporaryDirectory();
    const manager = new FileLockManager({ lockDir });
    const first = await manager.acquire("resource");

    await expect(manager.acquire("resource")).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await first.release();
    await first.release();
    const second = await manager.acquire("resource");
    await second.release();
  });

  it("recovers a stale same-host lock only when its process is no longer alive", async () => {
    const lockDir = await temporaryDirectory();
    const stale = new FileLockManager({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      host: "test-host",
      isProcessAlive: () => false,
      lockDir,
      pid: 101,
      staleAfterMs: 30_000,
    });
    const oldLease = await stale.acquire("resource");
    const current = new FileLockManager({
      clock: () => new Date("2026-08-13T00:01:00.000Z"),
      host: "test-host",
      isProcessAlive: () => false,
      lockDir,
      pid: 202,
      staleAfterMs: 30_000,
    });
    const currentLease = await current.acquire("resource");

    await oldLease.release();
    await expect(current.acquire("resource")).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await currentLease.release();
  });

  it("does not recover live, foreign-host, or corrupt locks", async () => {
    const lockDir = await temporaryDirectory();
    const live = new FileLockManager({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      host: "owner",
      isProcessAlive: () => true,
      lockDir,
      pid: 101,
      staleAfterMs: 1,
    });
    const liveLease = await live.acquire("live");
    const contender = new FileLockManager({
      clock: () => new Date("2026-08-13T00:01:00.000Z"),
      host: "owner",
      isProcessAlive: () => true,
      lockDir,
      pid: 202,
      staleAfterMs: 1,
    });
    await expect(contender.acquire("live")).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await liveLease.release();

    const foreign = new FileLockManager({
      clock: () => new Date("2026-08-13T00:00:00.000Z"),
      host: "foreign",
      isProcessAlive: () => false,
      lockDir,
      pid: 303,
      staleAfterMs: 1,
    });
    const foreignLease = await foreign.acquire("foreign");
    await expect(contender.acquire("foreign")).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await foreignLease.release();

    await writeFile(join(lockDir, `${sha256Text("corrupt")}.lock`), "invalid", {
      mode: 0o600,
    });
    await expect(contender.acquire("corrupt")).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
  });

  it("validates lock configuration before touching the filesystem", async () => {
    expect(() => new FileLockManager({ lockDir: "relative" })).toThrow("absolute");
    const lockDir = await temporaryDirectory();
    for (const options of [{ pid: 0 }, { staleAfterMs: 0 }, { pid: 1.5 }]) {
      expect(() => new FileLockManager({ lockDir, ...options })).toThrow("positive integers");
    }
  });

  it("treats every malformed lock field as a conflict and leaves it immutable", async () => {
    const lockDir = await temporaryDirectory();
    const manager = new FileLockManager({
      clock: () => new Date("2026-08-13T00:01:00.000Z"),
      host: "owner",
      isProcessAlive: () => false,
      lockDir,
      pid: 202,
      staleAfterMs: 1,
    });
    const base = {
      createdAt: "2026-08-13T00:00:00.000Z",
      host: "owner",
      pid: 101,
      resourceDigest: sha256Text("resource"),
      token: "token",
      version: 1,
    };
    for (const [index, malformed] of [
      null,
      [],
      { ...base, version: 2 },
      { ...base, createdAt: "invalid" },
      { ...base, host: 1 },
      { ...base, pid: 0 },
      { ...base, resourceDigest: "invalid" },
      { ...base, token: "" },
    ].entries()) {
      const resource = `malformed-${index}`;
      const filePath = join(lockDir, `${sha256Text(resource)}.lock`);
      await writeFile(filePath, JSON.stringify(malformed), { mode: 0o600 });
      await expect(manager.acquire(resource)).rejects.toMatchObject({
        code: "EVAL_STORE_CONFLICT",
      });
      await expect(access(filePath)).resolves.toBeUndefined();
    }
  });

  it("does not reclaim a lock whose embedded resource digest differs from its path", async () => {
    const lockDir = await temporaryDirectory();
    const resource = "resource";
    const filePath = join(lockDir, `${sha256Text(resource)}.lock`);
    await writeFile(
      filePath,
      JSON.stringify({
        createdAt: "2026-08-13T00:00:00.000Z",
        host: "owner",
        pid: 101,
        resourceDigest: sha256Text("different"),
        token: "token",
        version: 1,
      }),
      { mode: 0o600 },
    );
    const manager = new FileLockManager({
      clock: () => new Date("2026-08-13T00:01:00.000Z"),
      host: "owner",
      isProcessAlive: () => false,
      lockDir,
      pid: 202,
      staleAfterMs: 1,
    });

    await expect(manager.acquire(resource)).rejects.toMatchObject({
      code: "EVAL_STORE_CONFLICT",
    });
    await expect(access(filePath)).resolves.toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = join(
    tmpdir(),
    `yiku-eval-lock-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}
