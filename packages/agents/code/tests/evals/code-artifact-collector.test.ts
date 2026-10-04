import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Digest } from "@yiku/evals";
import { afterEach, describe, expect, it } from "vitest";
import { CodeArtifactCollector, WorkspaceContext } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CodeArtifactCollector", () => {
  it("captures added, modified, deleted, denied, and external symlink artifacts", async () => {
    const root = await workspace();
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(join(root, "src", "changed.ts"), "before\n");
    await writeFile(join(root, "src", "deleted.ts"), "delete\n");
    await writeFile(join(root, "src", "generated", "blocked.ts"), "before\n");
    const collector = new CodeArtifactCollector({
      allowedPaths: ["src"],
      deniedPaths: ["src/generated"],
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const before = await collector.capture();

    await writeFile(join(root, "src", "changed.ts"), "after\n");
    await rm(join(root, "src", "deleted.ts"));
    await writeFile(join(root, "src", "added.ts"), "added\n");
    await writeFile(join(root, "src", "generated", "blocked.ts"), "after\n");
    const external = await workspace();
    await writeFile(join(external, "external.ts"), "external\n");
    await symlink(join(external, "external.ts"), join(root, "src", "external.ts"));
    const after = await collector.capture();
    const artifacts = collector.compare(before, after);

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            changeType: "added",
            inScope: true,
            path: "src/added.ts",
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            changeType: "modified",
            path: "src/changed.ts",
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            changeType: "deleted",
            path: "src/deleted.ts",
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            inScope: false,
            path: "src/generated/blocked.ts",
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            externalSymlink: true,
            path: "src/external.ts",
          }),
        }),
      ]),
    );
    expect(artifacts.every((artifact) => artifact.kind === "file-change")).toBe(true);
    expect(before.digest).not.toBe(after.digest);
  });

  it("ignores configured runtime directories and returns no artifacts for identical snapshots", async () => {
    const root = await workspace();
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "ignored\n");
    await writeFile(join(root, "source.ts"), "source\n");
    const collector = new CodeArtifactCollector({
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const first = await collector.capture();
    const second = await collector.capture();

    expect(first.entries.map((entry) => entry.path)).toEqual(["source.ts"]);
    expect(collector.compare(first, second)).toEqual([]);
  });

  it("enforces file and byte limits and rejects tampered snapshots", async () => {
    const root = await workspace();
    await writeFile(join(root, "one.ts"), "one");
    await writeFile(join(root, "two.ts"), "two");
    await expect(
      new CodeArtifactCollector({
        maxFiles: 1,
        workspace: new WorkspaceContext({ rootDir: root }),
      }).capture(),
    ).rejects.toMatchObject({ code: "EVAL_INPUT_TOO_LARGE" });
    await expect(
      new CodeArtifactCollector({
        maxTotalBytes: 2,
        workspace: new WorkspaceContext({ rootDir: root }),
      }).capture(),
    ).rejects.toMatchObject({ code: "EVAL_INPUT_TOO_LARGE" });

    const collector = new CodeArtifactCollector({
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const snapshot = await collector.capture();
    expect(() =>
      collector.compare(
        {
          ...snapshot,
          totalBytes: snapshot.totalBytes + 1,
        },
        snapshot,
      ),
    ).toThrow("digest");
  });

  it("rejects unsafe scope paths", async () => {
    const root = await workspace();
    expect(
      () =>
        new CodeArtifactCollector({
          allowedPaths: ["../outside"],
          workspace: new WorkspaceContext({ rootDir: root }),
        }),
    ).toThrow("normalized relative path");
  });

  it("validates snapshot limits and malformed snapshot scalar fields", async () => {
    const root = await workspace();
    await writeFile(join(root, "source.ts"), "source");
    for (const options of [{ maxFiles: 0 }, { maxTotalBytes: 1.5 }]) {
      expect(
        () =>
          new CodeArtifactCollector({
            ...options,
            workspace: new WorkspaceContext({ rootDir: root }),
          }),
      ).toThrow("positive integer");
    }
    for (const allowedPath of ["/absolute", "src/./nested", "bad\0path"]) {
      expect(
        () =>
          new CodeArtifactCollector({
            allowedPaths: [allowedPath],
            workspace: new WorkspaceContext({ rootDir: root }),
          }),
      ).toThrow("normalized relative path");
    }

    const collector = new CodeArtifactCollector({
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const snapshot = await collector.capture();
    for (const invalid of [
      { ...snapshot, version: 2 },
      { ...snapshot, digest: "invalid" },
      { ...snapshot, totalBytes: -1 },
      { ...snapshot, totalBytes: 1.5 },
    ]) {
      expect(() => collector.compare(invalid as typeof snapshot, snapshot)).toThrow(
        "snapshot is invalid",
      );
    }
  });

  it("captures internal and dangling symlinks and detects mode-only changes", async () => {
    const root = await workspace();
    await writeFile(join(root, "target.ts"), "target");
    await writeFile(join(root, "mode.ts"), "mode");
    await symlink("target.ts", join(root, "internal.ts"));
    await symlink("missing.ts", join(root, "dangling.ts"));
    const collector = new CodeArtifactCollector({
      allowedPaths: ["./", "src/", ""],
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const before = await collector.capture();
    expect(before.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ external: false, path: "internal.ts", type: "symlink" }),
        expect.objectContaining({ external: true, path: "dangling.ts", type: "symlink" }),
      ]),
    );

    await chmod(join(root, "mode.ts"), 0o600);
    const after = await collector.capture();
    expect(collector.compare(before, after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            changeType: "modified",
            mode: 0o600,
            path: "mode.ts",
          }),
        }),
      ]),
    );

    const semantic = {
      entries: after.entries,
      totalBytes: after.totalBytes,
      version: after.version,
    };
    expect(() =>
      collector.compare(
        {
          ...after,
          digest: sha256Digest({ ...semantic, totalBytes: after.totalBytes + 1 }),
          totalBytes: after.totalBytes + 1,
        },
        after,
      ),
    ).not.toThrow();
  });

  it("enforces aggregate byte limits and normalizes incomplete snapshot entries safely", async () => {
    const root = await workspace();
    await writeFile(join(root, "one.ts"), "12");
    await writeFile(join(root, "two.ts"), "34");
    await expect(
      new CodeArtifactCollector({
        maxTotalBytes: 3,
        workspace: new WorkspaceContext({ rootDir: root }),
      }).capture(),
    ).rejects.toMatchObject({ code: "EVAL_INPUT_TOO_LARGE" });

    const collector = new CodeArtifactCollector({
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const emptySemantic = {
      entries: [],
      totalBytes: 0,
      version: 1 as const,
    };
    const entry = {
      digest: "a".repeat(64),
      path: "minimal.ts",
    };
    const addedSemantic = {
      entries: [entry],
      totalBytes: 0,
      version: 1 as const,
    };
    const artifacts = collector.compare(
      {
        ...emptySemantic,
        digest: sha256Digest(emptySemantic),
      },
      {
        ...addedSemantic,
        digest: sha256Digest(addedSemantic),
      } as Parameters<CodeArtifactCollector["compare"]>[1],
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        metadata: {
          afterDigest: "a".repeat(64),
          beforeDigest: "",
          changeType: "added",
          externalSymlink: false,
          inScope: true,
          mode: 0,
          path: "minimal.ts",
          type: "file",
        },
        sizeBytes: 0,
      }),
    ]);
  });
});

async function workspace(): Promise<string> {
  const directory = join(
    tmpdir(),
    `yiku-code-artifact-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}
