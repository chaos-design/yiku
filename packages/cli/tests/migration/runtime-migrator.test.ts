import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { YikuPaths } from "@yiku/config";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyRuntime } from "../../src/migration/runtime-migrator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("migrateLegacyRuntime", () => {
  it("copies runtime data, resolves conflicts, and removes only migrated sources", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const legacyRoot = join(workspaceDir, ".yiku");
    const paths = new YikuPaths({ homeDir, workspaceDir });
    await mkdir(join(legacyRoot, "sessions"), { recursive: true });
    await mkdir(join(legacyRoot, "atomic-runs", "run-1"), { recursive: true });
    await mkdir(join(legacyRoot, "runs", "run-1"), { recursive: true });
    await mkdir(join(legacyRoot, "trust"), { recursive: true });
    await mkdir(join(legacyRoot, "agents"), { recursive: true });
    await mkdir(paths.sessionsDir, { recursive: true });
    await writeFile(join(legacyRoot, "sessions", "session-1.jsonl"), "legacy\n");
    await writeFile(join(legacyRoot, "sessions", "same.jsonl"), "same\n");
    await writeFile(join(paths.sessionsDir, "session-1.jsonl"), "current\n");
    await writeFile(join(paths.sessionsDir, "session-1.jsonl.legacy-20260809000000"), "older\n");
    await writeFile(join(paths.sessionsDir, "same.jsonl"), "same\n");
    await writeFile(join(legacyRoot, "atomic-runs", "run-1", "flow.jsonl"), "{}\n");
    await writeFile(join(legacyRoot, "runs", "run-1", "flow.jsonl"), "{}\n");
    await writeFile(join(legacyRoot, "trust", "workspace.json"), "{}\n");
    await writeFile(join(legacyRoot, "agents", "reviewer.md"), "agent\n");
    const database = new DatabaseSync(join(legacyRoot, "memories.sqlite"));
    database.exec("CREATE TABLE memory (value TEXT); INSERT INTO memory VALUES ('remembered');");
    database.close();

    const result = await migrateLegacyRuntime({
      homeDir,
      now: new Date("2026-08-09T00:00:00.000Z"),
      workspaceDir,
    });

    expect(result.migrated).toBe(true);
    expect(await readFile(join(paths.sessionsDir, "session-1.jsonl"), "utf8")).toBe("current\n");
    expect(await readdir(paths.sessionsDir)).toContain("session-1.jsonl.legacy-20260809000000-1");
    expect((await readdir(paths.sessionsDir)).filter((path) => path.startsWith("same"))).toEqual([
      "same.jsonl",
    ]);
    expect(existsSync(join(paths.atomicRunsDir, "run-1", "flow.jsonl"))).toBe(true);
    expect(existsSync(join(paths.runsDir, "run-1", "flow.jsonl"))).toBe(true);
    const migratedDatabase = new DatabaseSync(paths.workspaceMemoryFilePath, {
      readOnly: true,
    });
    expect(migratedDatabase.prepare("SELECT value FROM memory").get()).toEqual({
      value: "remembered",
    });
    migratedDatabase.close();
    expect(existsSync(join(legacyRoot, "sessions"))).toBe(false);
    expect(existsSync(join(legacyRoot, "trust"))).toBe(false);
    expect(existsSync(join(legacyRoot, "agents", "reviewer.md"))).toBe(true);
    await expect(migrateLegacyRuntime({ homeDir, workspaceDir })).resolves.toMatchObject({
      migrated: false,
    });
  });

  it("preserves a symbolic-link source when migration fails", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const outsideDir = join(root, "outside");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(workspaceDir, ".yiku", "sessions"));

    await expect(migrateLegacyRuntime({ homeDir, workspaceDir })).rejects.toThrow(
      "must not be a symbolic link",
    );
    expect(existsSync(join(workspaceDir, ".yiku", "sessions"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "rejects runtime sources that are not files or directories",
    async () => {
      const root = await temporaryDirectory();
      const homeDir = join(root, "home");
      const workspaceDir = join(root, "workspace");
      const sourcePath = join(workspaceDir, ".yiku", "sessions");
      await mkdir(dirname(sourcePath), { recursive: true });
      execFileSync("mkfifo", [sourcePath]);

      await expect(migrateLegacyRuntime({ homeDir, workspaceDir })).rejects.toThrow(
        "must be a file or directory",
      );
      expect(existsSync(sourcePath)).toBe(true);
    },
  );

  it("removes a legacy Trust record even when there are no runtime files", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const trustPath = join(workspaceDir, ".yiku", "trust", "workspace.json");
    await mkdir(join(workspaceDir, ".yiku", "trust"), { recursive: true });
    await writeFile(trustPath, "{}\n");

    await expect(migrateLegacyRuntime({ homeDir, workspaceDir })).resolves.toMatchObject({
      migrated: true,
      removedPaths: [trustPath],
    });
    expect(existsSync(join(workspaceDir, ".yiku"))).toBe(false);
  });

  it("preserves runtime sources when Workspace metadata cannot be replaced", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const sourcePath = join(workspaceDir, ".yiku", "sessions", "session.jsonl");
    const paths = new YikuPaths({ homeDir, workspaceDir });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "{}\n");
    await mkdir(paths.workspaceMetadataFilePath, { recursive: true });

    await expect(migrateLegacyRuntime({ homeDir, workspaceDir })).rejects.toThrow();
    expect(existsSync(sourcePath)).toBe(true);
    expect((await readdir(paths.workspaceStorageDir)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-runtime-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}
