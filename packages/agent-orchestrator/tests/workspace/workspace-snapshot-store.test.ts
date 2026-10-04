import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWorkspaceSnapshotManifest,
  WORKSPACE_SNAPSHOT_MANIFEST_VERSION,
} from "../../src/workspace/snapshot-types.js";
import {
  WorkspaceSnapshotLimitError,
  WorkspaceSnapshotStore,
} from "../../src/workspace/workspace-snapshot-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("workspace snapshot manifest schema", () => {
  it("rejects unsafe paths, duplicate entries, and invalid hashes", () => {
    for (const path of ["/absolute.txt", "../escape.txt", "dir/../escape.txt", "C:/escape.txt"]) {
      expect(() => parseWorkspaceSnapshotManifest(manifest([{ path }]))).toThrow();
    }

    expect(() =>
      parseWorkspaceSnapshotManifest(
        manifest([{ path: "duplicate.txt" }, { path: "duplicate.txt" }]),
      ),
    ).toThrow(/duplicated/u);
    expect(() =>
      parseWorkspaceSnapshotManifest(manifest([{ hash: "not-a-hash", path: "file.txt" }])),
    ).toThrow(/SHA-256/u);
  });
});

describe("WorkspaceSnapshotStore", () => {
  it("validates directories, limits, exclusions, capture input, and IDs", async () => {
    const fixture = await workspaceFixture();
    expect(
      () =>
        new WorkspaceSnapshotStore({
          storageDir: "relative",
          workspaceDir: fixture.workspace,
        }),
    ).toThrow("must be absolute");
    expect(
      () =>
        new WorkspaceSnapshotStore({
          storageDir: fixture.workspace,
          workspaceDir: fixture.workspace,
        }),
    ).toThrow("must not be the workspace root");
    for (const limits of [{ bytes: -1 }, { files: 1.5 }]) {
      expect(() => new WorkspaceSnapshotStore({ ...fixture, limits })).toThrow(
        "non-negative safe integer",
      );
    }
    for (const exclude of ["", "/absolute", "../escape", "a\\b", "a//b", "C:/escape"]) {
      expect(() => new WorkspaceSnapshotStore({ ...fixture, exclude: [exclude] })).toThrow(
        "relative POSIX paths",
      );
    }

    const store = new WorkspaceSnapshotStore(fixture);
    await expect(store.capture({ sessionId: "", sessionRevision: 1 })).rejects.toThrow(
      "Session ID must not be empty",
    );
    await expect(store.capture({ sessionId: "session", sessionRevision: -1 })).rejects.toThrow(
      "revision",
    );
    await expect(store.load("invalid")).rejects.toThrow("must be a UUID");
    await expect(store.remove("../escape")).rejects.toThrow("must be a UUID");
  });

  it("rejects non-directory roots, root links, mismatched manifests, and invalid journals", async () => {
    const fixture = await workspaceFixture();
    const fileRoot = join(fixture.root, "file-root");
    await writeFile(fileRoot, "file");
    await expect(
      new WorkspaceSnapshotStore({
        storageDir: fixture.storage,
        workspaceDir: fileRoot,
      }).capture({ sessionId: "session", sessionRevision: 1 }),
    ).rejects.toThrow("root must be a directory");

    const linkedRoot = join(fixture.root, "linked-root");
    await symlink(fixture.workspace, linkedRoot);
    await expect(
      new WorkspaceSnapshotStore({
        storageDir: fixture.storage,
        workspaceDir: linkedRoot,
      }).capture({ sessionId: "session", sessionRevision: 1 }),
    ).rejects.toThrow("root must not be a symbolic link");

    await writeFile(join(fixture.workspace, "file.txt"), "content");
    const store = new WorkspaceSnapshotStore(fixture);
    const captured = await store.capture({ sessionId: "session", sessionRevision: 1 });
    const manifestPath = join(fixture.storage, "manifests", `${captured.id}.json`);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...captured,
        id: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
    await expect(store.load(captured.id)).rejects.toThrow("ID does not match");

    const transactionDir = join(fixture.storage, "transactions", randomUUID());
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(transactionDir, "journal.json"), JSON.stringify({ status: "bad" }));
    await expect(store.recover()).rejects.toThrow("restore journal is invalid");
  });

  it("deduplicates blobs and applies default, custom, and storage exclusions", async () => {
    const fixture = await workspaceFixture(true);
    await mkdir(join(fixture.workspace, ".git"));
    await mkdir(join(fixture.workspace, "node_modules"));
    await mkdir(join(fixture.workspace, "nested"));
    await mkdir(join(fixture.workspace, "ignored"));
    await writeFile(join(fixture.workspace, ".git", "config"), "excluded");
    await writeFile(join(fixture.workspace, "node_modules", "dependency.js"), "excluded");
    await writeFile(join(fixture.workspace, "ignored", "secret.txt"), "excluded");
    await writeFile(join(fixture.workspace, "a.txt"), "same content");
    await writeFile(join(fixture.workspace, "nested", "b.txt"), "same content");

    const store = new WorkspaceSnapshotStore({
      exclude: ["ignored"],
      storageDir: fixture.storage,
      workspaceDir: fixture.workspace,
    });
    const first = await store.capture({ sessionId: "session-1", sessionRevision: 1 });
    const second = await store.capture({ sessionId: "session-1", sessionRevision: 2 });

    expect(first.entries.map((entry) => entry.path)).toEqual(["a.txt", "nested/b.txt"]);
    expect(first.entries[0]?.hash).toBe(first.entries[1]?.hash);
    expect(second.entries.map((entry) => entry.path)).toEqual(["a.txt", "nested/b.txt"]);
    expect(await readdir(join(fixture.storage, "blobs"))).toHaveLength(1);
    expect(await readdir(join(fixture.storage, "manifests"))).toHaveLength(2);
  });

  it("rejects symbolic links", async () => {
    const fixture = await workspaceFixture();
    const outside = join(fixture.root, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(fixture.workspace, "linked.txt"));
    const store = new WorkspaceSnapshotStore(fixture);

    await expect(store.capture({ sessionId: "session-1", sessionRevision: 1 })).rejects.toThrow(
      /symbolic links/u,
    );
  });

  it.each([
    {
      limits: { files: 1 },
      prepare: async (workspace: string) => {
        await writeFile(join(workspace, "a.txt"), "a");
        await writeFile(join(workspace, "b.txt"), "b");
      },
    },
    {
      limits: { bytes: 3 },
      prepare: async (workspace: string) => {
        await writeFile(join(workspace, "large.txt"), "four");
      },
    },
  ])("does not write a manifest when a limit is exceeded", async ({ limits, prepare }) => {
    const fixture = await workspaceFixture();
    await prepare(fixture.workspace);
    const store = new WorkspaceSnapshotStore({ ...fixture, limits });

    await expect(
      store.capture({ sessionId: "session-1", sessionRevision: 1 }),
    ).rejects.toBeInstanceOf(WorkspaceSnapshotLimitError);
    await expect(readdir(join(fixture.storage, "manifests"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves modes in loadable manifests and removes only the manifest", async () => {
    const fixture = await workspaceFixture();
    const executable = join(fixture.workspace, "run.sh");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o750);
    const store = new WorkspaceSnapshotStore(fixture);

    const captured = await store.capture({
      eventHead: "event-9",
      sessionId: "session-1",
      sessionRevision: 7,
    });
    const entry = captured.entries[0];
    expect(entry).toMatchObject({ mode: 0o750, path: "run.sh", type: "file" });
    expect(await store.load(captured.id)).toEqual(captured);

    const manifestPath = join(fixture.storage, "manifests", `${captured.id}.json`);
    const blobPath = join(fixture.storage, "blobs", entry?.hash ?? "");
    expect((await stat(fixture.storage)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.storage, "blobs"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.storage, "manifests"))).mode & 0o777).toBe(0o700);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o600);

    await store.remove(captured.id);

    await expect(access(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(blobPath)).resolves.toBeUndefined();
    await expect(store.load(captured.id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores modified, deleted, added, and mode-changed files", async () => {
    const fixture = await workspaceFixture(true);
    await mkdir(join(fixture.workspace, ".git"));
    await mkdir(join(fixture.workspace, "nested"));
    await writeFile(join(fixture.workspace, ".git", "state"), "captured exclusion");
    await writeFile(join(fixture.workspace, "keep.txt"), "captured keep");
    await writeFile(join(fixture.workspace, "nested", "deleted.txt"), "captured deleted");
    const executable = join(fixture.workspace, "run.sh");
    await writeFile(executable, "#!/bin/sh\necho captured\n");
    await chmod(executable, 0o750);

    const store = new WorkspaceSnapshotStore(fixture);
    const captured = await store.capture({ sessionId: "session-1", sessionRevision: 1 });

    await writeFile(join(fixture.workspace, ".git", "state"), "current exclusion");
    await writeFile(join(fixture.workspace, "keep.txt"), "current keep");
    await rm(join(fixture.workspace, "nested", "deleted.txt"));
    await writeFile(executable, "#!/bin/sh\necho current\n");
    await chmod(executable, 0o600);
    await writeFile(join(fixture.workspace, "added.txt"), "current added");
    await mkdir(join(fixture.workspace, "scratch"));
    await writeFile(join(fixture.workspace, "scratch", "added.txt"), "current nested added");

    await store.restore(captured.id);

    await expect(readFile(join(fixture.workspace, "keep.txt"), "utf8")).resolves.toBe(
      "captured keep",
    );
    await expect(readFile(join(fixture.workspace, "nested", "deleted.txt"), "utf8")).resolves.toBe(
      "captured deleted",
    );
    await expect(readFile(executable, "utf8")).resolves.toBe("#!/bin/sh\necho captured\n");
    expect((await stat(executable)).mode & 0o777).toBe(0o750);
    await expect(access(join(fixture.workspace, "added.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(fixture.workspace, "scratch"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(fixture.workspace, ".git", "state"), "utf8")).resolves.toBe(
      "current exclusion",
    );
    expect(await readdir(join(fixture.storage, "manifests"))).toEqual([`${captured.id}.json`]);
    expect(await readdir(join(fixture.storage, "transactions"))).toEqual([]);
  });

  it("rolls back to the pre-restore workspace when the second target entry fails", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.workspace, "a.txt"), "target a");
    await writeFile(join(fixture.workspace, "b.txt"), "target b");
    const initialStore = new WorkspaceSnapshotStore(fixture);
    const target = await initialStore.capture({ sessionId: "session-1", sessionRevision: 1 });

    await writeFile(join(fixture.workspace, "a.txt"), "current a");
    await writeFile(join(fixture.workspace, "b.txt"), "current b");
    await writeFile(join(fixture.workspace, "c.txt"), "current c");
    await chmod(join(fixture.workspace, "a.txt"), 0o600);

    const calls: { readonly index: number; readonly path: string; readonly phase: string }[] = [];
    const injected = new Error("injected second target failure");
    let backupMode: number | undefined;
    let journal: unknown;
    let journalMode: number | undefined;
    const store = new WorkspaceSnapshotStore({
      ...fixture,
      beforeApplyEntry: async (path, index, phase) => {
        calls.push({ index, path, phase });
        if (phase !== "target" || index !== 1) {
          return;
        }

        const transaction = (await readdir(join(fixture.storage, "transactions")))[0];
        if (transaction === undefined) {
          throw new Error("Restore transaction was not created.");
        }
        const transactionDir = join(fixture.storage, "transactions", transaction);
        const journalPath = join(transactionDir, "journal.json");
        journal = JSON.parse(await readFile(journalPath, "utf8"));
        journalMode = (await stat(journalPath)).mode & 0o777;
        backupMode = (await stat(join(transactionDir, "backup.json"))).mode & 0o777;
        throw injected;
      },
    });

    await expect(store.restore(target.id)).rejects.toBe(injected);

    await expect(readFile(join(fixture.workspace, "a.txt"), "utf8")).resolves.toBe("current a");
    await expect(readFile(join(fixture.workspace, "b.txt"), "utf8")).resolves.toBe("current b");
    await expect(readFile(join(fixture.workspace, "c.txt"), "utf8")).resolves.toBe("current c");
    expect((await stat(join(fixture.workspace, "a.txt"))).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      { index: 0, path: "a.txt", phase: "target" },
      { index: 1, path: "b.txt", phase: "target" },
      { index: 0, path: "a.txt", phase: "rollback" },
      { index: 1, path: "b.txt", phase: "rollback" },
      { index: 2, path: "c.txt", phase: "rollback" },
    ]);
    expect(journal).toMatchObject({
      backupManifest: { sessionId: "__restore__" },
      status: "applying",
      targetId: target.id,
    });
    expect(journalMode).toBe(0o600);
    expect(backupMode).toBe(0o600);
    expect(await readdir(join(fixture.storage, "manifests"))).toEqual([`${target.id}.json`]);
    expect(await readdir(join(fixture.storage, "transactions"))).toEqual([]);
  });

  it("recovers stale applying journals and cleans committed journals", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.workspace, "a.txt"), "backup a");
    await writeFile(join(fixture.workspace, "b.txt"), "backup b");
    const store = new WorkspaceSnapshotStore(fixture);
    const backup = await store.capture({ sessionId: "session-1", sessionRevision: 1 });
    await store.remove(backup.id);

    await writeFile(join(fixture.workspace, "a.txt"), "partially applied");
    await rm(join(fixture.workspace, "b.txt"));
    await writeFile(join(fixture.workspace, "target-only.txt"), "partial target");

    const applyingId = randomUUID();
    const applyingDir = join(fixture.storage, "transactions", applyingId);
    await mkdir(applyingDir, { mode: 0o700 });
    await writeFile(join(applyingDir, "backup.json"), `${JSON.stringify(backup)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(applyingDir, "journal.json"),
      `${JSON.stringify({
        backupManifest: backup,
        status: "applying",
        targetId: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );

    await store.recover();

    await expect(readFile(join(fixture.workspace, "a.txt"), "utf8")).resolves.toBe("backup a");
    await expect(readFile(join(fixture.workspace, "b.txt"), "utf8")).resolves.toBe("backup b");
    await expect(access(join(fixture.workspace, "target-only.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(fixture.storage, "transactions"))).toEqual([]);
    expect(await readdir(join(fixture.storage, "manifests"))).toEqual([]);

    const committedId = randomUUID();
    const committedDir = join(fixture.storage, "transactions", committedId);
    await mkdir(committedDir, { mode: 0o700 });
    await writeFile(
      join(committedDir, "journal.json"),
      `${JSON.stringify({
        backupManifest: backup,
        status: "committed",
        targetId: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(fixture.workspace, "a.txt"), "committed workspace");

    await store.recover();

    await expect(readFile(join(fixture.workspace, "a.txt"), "utf8")).resolves.toBe(
      "committed workspace",
    );
    expect(await readdir(join(fixture.storage, "transactions"))).toEqual([]);
  });

  it("rejects a same-size blob hash mismatch before changing the workspace", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.workspace, "file.txt"), "good");
    const store = new WorkspaceSnapshotStore(fixture);
    const target = await store.capture({ sessionId: "session-1", sessionRevision: 1 });
    const entry = target.entries[0];
    if (entry === undefined) {
      throw new Error("Expected captured entry.");
    }

    await writeFile(join(fixture.workspace, "file.txt"), "current");
    await writeFile(join(fixture.storage, "blobs", entry.hash), "evil");

    await expect(store.restore(target.id)).rejects.toThrow(/hash does not match/u);

    await expect(readFile(join(fixture.workspace, "file.txt"), "utf8")).resolves.toBe("current");
    expect(await readdir(join(fixture.storage, "transactions"))).toEqual([]);
  });
});

interface WorkspaceFixture {
  readonly root: string;
  readonly storageDir: string;
  readonly storage: string;
  readonly workspace: string;
  readonly workspaceDir: string;
}

async function workspaceFixture(storageInsideWorkspace = false): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "yiku-workspace-snapshot-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const storage = storageInsideWorkspace ? join(workspace, ".snapshots") : join(root, "storage");
  await mkdir(workspace);
  return {
    root,
    storage,
    storageDir: storage,
    workspace,
    workspaceDir: workspace,
  };
}

function manifest(
  entries: readonly {
    readonly hash?: string;
    readonly path: string;
  }[],
): unknown {
  return {
    createdAt: "2026-08-10T00:00:00.000Z",
    entries: entries.map((entry) => ({
      hash: entry.hash ?? "a".repeat(64),
      mode: 0o644,
      path: entry.path,
      size: 1,
      type: "file",
    })),
    id: "123e4567-e89b-42d3-a456-426614174000",
    sessionId: "session-1",
    sessionRevision: 1,
    version: WORKSPACE_SNAPSHOT_MANIFEST_VERSION,
  };
}
