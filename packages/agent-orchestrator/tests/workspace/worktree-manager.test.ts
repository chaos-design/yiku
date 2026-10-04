import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceContext } from "@yiku/agent-code";
import {
  CallbackHookExecutor,
  type HookCallback,
  HookConfigCompiler,
  HookEngine,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorktreeManager,
  type WorktreeManagerError,
} from "../../src/workspace/worktree-manager.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("WorktreeManager", () => {
  it("creates, persists, collects, and safely removes detached Worktrees", async () => {
    const fixture = await repositoryFixture();
    const manager = new WorktreeManager({
      idGenerator: () => "worktree-1",
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });
    const handle = await manager.create({
      name: "Feature Review",
      taskId: "task-1",
    });

    expect(basename(handle.path)).toBe("feature-review-worktree-1");
    expect(handle.baseRevision).toMatch(/^[a-f0-9]{40}$/u);
    expect(await manager.list()).toEqual([handle]);
    expect(
      await new WorktreeManager({
        storageDir: fixture.storage,
        workspaceDir: fixture.repository,
      }).list(),
    ).toEqual([handle]);

    await writeFile(join(handle.path, "README.md"), "changed\n");
    await mkdir(join(handle.path, "src"));
    await writeFile(join(handle.path, "src/new.ts"), "export const value = 1;\n");
    const changes = await manager.collectChanges(handle);
    expect(changes.changedFiles).toEqual(["README.md", "src/new.ts"]);
    expect(changes.patch).toContain("changed");
    expect(changes.patch).toContain("src/new.ts");

    await expect(manager.remove(handle)).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
    });
    await manager.remove(handle, { force: true });
    await expect(access(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.list()).resolves.toEqual([]);
  }, 15_000);

  it("applies create updates and allows remove Hooks to block before Git effects", async () => {
    const fixture = await repositoryFixture();
    const session = hookSession({
      WorktreeCreate: () => ({ updatedInput: { name: "Hooked Name" } }),
      WorktreeRemove: () => ({ action: "block", reason: "retain for review" }),
    });
    const options = {
      hookContext: {
        permissionMode: "default",
        sessionId: "session-1",
        transcriptPath: "/tmp/transcript.jsonl",
      },
      hookSession: session,
      idGenerator: () => "hooked",
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    } as const;
    const manager = new WorktreeManager(options);

    try {
      const handle = await manager.create({ name: "Original", taskId: "task-hook" });
      expect(basename(handle.path)).toBe("hooked-name-hooked");
      await expect(manager.remove(handle)).rejects.toMatchObject({
        code: "WORKTREE_HOOK_BLOCKED",
      });
      await expect(access(handle.path)).resolves.toBeUndefined();

      await new WorktreeManager({
        storageDir: fixture.storage,
        workspaceDir: fixture.repository,
      }).remove(handle, { force: true });
    } finally {
      await session.close();
    }
  });

  it("does not create a Worktree when the create Hook blocks", async () => {
    const fixture = await repositoryFixture();
    const session = hookSession({
      WorktreeCreate: () => ({ action: "block", reason: "policy denied" }),
    });
    const manager = new WorktreeManager({
      hookContext: {
        permissionMode: "default",
        sessionId: "session-1",
        transcriptPath: "/tmp/transcript.jsonl",
      },
      hookSession: session,
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });

    try {
      await expect(manager.create({ taskId: "blocked" })).rejects.toMatchObject({
        code: "WORKTREE_HOOK_BLOCKED",
      });
      expect(
        (await git(fixture.repository, ["worktree", "list", "--porcelain"])).stdout,
      ).not.toContain(fixture.storage);
      await expect(manager.list()).resolves.toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("reports non-Git and unborn repositories as unavailable", async () => {
    const parent = await temporaryDirectory();
    const nonGit = join(parent, "non-git");
    const unborn = join(parent, "unborn");
    const storage = join(parent, "storage");
    await mkdir(nonGit);
    await mkdir(unborn);
    await git(unborn, ["init"]);

    for (const workspaceDir of [nonGit, unborn]) {
      const manager = new WorktreeManager({ storageDir: storage, workspaceDir });
      await expect(manager.create({ taskId: "task" })).rejects.toMatchObject<
        Partial<WorktreeManagerError>
      >({
        code: "GIT_WORKTREE_UNAVAILABLE",
      });
    }
  });

  it("refuses to isolate from a dirty source Worktree", async () => {
    const fixture = await repositoryFixture();
    await writeFile(join(fixture.repository, "uncommitted.txt"), "local state\n");
    const manager = new WorktreeManager({
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });

    await expect(manager.create({ taskId: "dirty" })).rejects.toMatchObject({
      code: "GIT_WORKTREE_UNAVAILABLE",
    });
    expect(
      (await git(fixture.repository, ["worktree", "list", "--porcelain"])).stdout,
    ).not.toContain(fixture.storage);
  });

  it("rejects a managed Worktree path replaced by an external symbolic link", async () => {
    const fixture = await repositoryFixture();
    const manager = new WorktreeManager({
      idGenerator: () => "replace",
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });
    const handle = await manager.create({ taskId: "replace" });
    const outside = join(fixture.repository, "outside");
    await mkdir(outside);
    await rm(handle.path, { force: true, recursive: true });
    await symlink(outside, handle.path);

    await expect(manager.collectChanges(handle)).rejects.toMatchObject({
      code: "WORKTREE_HANDLE_INVALID",
    });
  });

  it("handles clean removal, empty changes, and invalid handles", async () => {
    const fixture = await repositoryFixture();
    const manager = new WorktreeManager({
      idGenerator: () => "clean",
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });
    const handle = await manager.create({ taskId: "clean" });

    await expect(manager.collectChanges(handle)).resolves.toEqual({
      changedFiles: [],
      patch: "",
    });
    await expect(
      manager.collectChanges({
        ...handle,
        path: fixture.repository,
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_HANDLE_INVALID",
    });
    await expect(
      manager.collectChanges({
        ...handle,
        id: "missing",
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_METADATA_INVALID",
    });
    await manager.remove(handle);
    await expect(manager.list()).resolves.toEqual([]);
  });

  it("rejects invalid IDs, revisions, and Hook updates or deferrals", async () => {
    const fixture = await repositoryFixture();
    await expect(
      new WorktreeManager({
        idGenerator: () => "../escape",
        storageDir: fixture.storage,
        workspaceDir: fixture.repository,
      }).create({ taskId: "invalid-id" }),
    ).rejects.toMatchObject({
      code: "WORKTREE_METADATA_INVALID",
    });
    await expect(
      new WorktreeManager({
        storageDir: fixture.storage,
        workspaceDir: fixture.repository,
      }).create({ baseRevision: "--force", taskId: "invalid-revision" }),
    ).rejects.toMatchObject({
      code: "WORKTREE_METADATA_INVALID",
    });
    await expect(
      new WorktreeManager({
        storageDir: fixture.storage,
        workspaceDir: fixture.repository,
      }).create({ taskId: " " }),
    ).rejects.toMatchObject({
      code: "WORKTREE_METADATA_INVALID",
    });

    for (const hookCase of [
      {
        code: "WORKTREE_METADATA_INVALID",
        output: { updatedInput: { path: "/tmp/outside" } },
      },
      {
        code: "WORKTREE_METADATA_INVALID",
        output: { updatedInput: { name: 42 } },
      },
      { code: "WORKTREE_HOOK_DEFERRED", output: { action: "defer" } },
      { code: "WORKTREE_HOOK_BLOCKED", output: { action: "block" } },
    ] as const) {
      const session = hookSession({
        WorktreeCreate: () => hookCase.output,
      });
      try {
        await expect(
          new WorktreeManager({
            hookContext: {
              permissionMode: "default",
              sessionId: "session-invalid",
              transcriptPath: "/tmp/transcript.jsonl",
            },
            hookSession: session,
            storageDir: fixture.storage,
            workspaceDir: fixture.repository,
          }).create({ taskId: "hook-invalid" }),
        ).rejects.toMatchObject({
          code: hookCase.code,
        });
      } finally {
        await session.close();
      }
    }
  });

  it("collects rename status and rejects non-object persisted metadata", async () => {
    const fixture = await repositoryFixture();
    const workspace = new WorkspaceContext({ rootDir: fixture.repository });
    const manager = new WorktreeManager({
      idGenerator: () => "rename",
      storageDir: fixture.storage,
      workspaceDir: fixture.repository,
    });
    const handle = await manager.create({ taskId: "rename" });
    await git(handle.path, ["mv", "README.md", "RENAMED.md"]);

    await expect(manager.collectChanges(handle)).resolves.toMatchObject({
      changedFiles: ["RENAMED.md"],
    });
    await manager.remove(handle, { force: true });

    const recordsDir = join(fixture.storage, workspace.workspaceId, "records");
    await writeFile(join(recordsDir, "invalid.json"), "null\n");
    await expect(manager.list()).rejects.toMatchObject({
      code: "WORKTREE_METADATA_INVALID",
    });
  });
});

function hookSession(
  handlers: Readonly<Partial<Record<"WorktreeCreate" | "WorktreeRemove", HookCallback>>>,
): HookSession {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    { source: hookSource("runtime"), value: { hooks } },
  ]).snapshot;
  return new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });
}

async function repositoryFixture(): Promise<{
  readonly repository: string;
  readonly storage: string;
}> {
  const parent = await temporaryDirectory();
  const repository = join(parent, "repository");
  const storage = join(parent, "worktrees");
  await mkdir(repository);
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "test@example.test"]);
  await git(repository, ["config", "user.name", "Yiku Test"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  return { repository, storage };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-worktree-manager-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, args: readonly string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
}
