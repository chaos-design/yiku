import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStorageLocator } from "../src/workspace-storage-locator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("WorkspaceStorageLocator", () => {
  it("uses the readable base name for the first workspace", async () => {
    const { homeDir, root } = await createFixture();
    const workspaceDir = join(root, "projects", "app");
    await mkdir(workspaceDir, { recursive: true });

    const resolution = await new WorkspaceStorageLocator({
      homeDir,
      workspaceDir,
    }).resolve();

    const rootRealPath = await realpath(workspaceDir);
    expect(resolution).toMatchObject({
      metadataPath: join(homeDir, ".yiku", "workspaces", "projects_app", "workspace.json"),
      rootRealPath,
      storageDir: join(homeDir, ".yiku", "workspaces", "projects_app"),
      storageName: "projects_app",
    });
    expect(resolution.paths.workspaceStorageName).toBe("projects_app");
    expect(JSON.parse(await readFile(resolution.metadataPath, "utf8"))).toMatchObject({
      rootRealPath,
    });
  });

  it("reuses a readable base name with matching metadata", async () => {
    const { homeDir, root } = await createFixture();
    const workspaceDir = join(root, "projects", "app");
    await mkdir(workspaceDir, { recursive: true });

    const first = await new WorkspaceStorageLocator({ homeDir, workspaceDir }).resolve();
    const second = await new WorkspaceStorageLocator({ homeDir, workspaceDir }).resolve();

    expect(second.storageName).toBe("projects_app");
    expect(second.storageDir).toBe(first.storageDir);
    expect(second.metadataPath).toBe(first.metadataPath);
  });

  it("adds an eight-character path hash when the readable name is owned", async () => {
    const { homeDir, root } = await createFixture();
    const first = join(root, "one", "projects", "app");
    const second = join(root, "two", "projects", "app");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await new WorkspaceStorageLocator({ homeDir, workspaceDir: first }).resolve();

    const resolution = await new WorkspaceStorageLocator({
      homeDir,
      workspaceDir: second,
    }).resolve();

    const secondRealPath = await realpath(second);
    const expectedHash = createHash("sha256").update(secondRealPath).digest("hex").slice(0, 8);
    expect(resolution.storageName).toBe(`projects_app_${expectedHash}`);
    expect(JSON.parse(await readFile(resolution.metadataPath, "utf8"))).toMatchObject({
      rootRealPath: secondRealPath,
    });
  });

  it("uses the hash name when readable base metadata is unusable", async () => {
    const { homeDir, root } = await createFixture();
    const workspaceDir = join(root, "projects", "app");
    const baseStorageDir = join(homeDir, ".yiku", "workspaces", "projects_app");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(baseStorageDir, { recursive: true });
    await writeFile(join(baseStorageDir, "workspace.json"), "{not-json", "utf8");

    const resolution = await new WorkspaceStorageLocator({
      digest: () => "12345678",
      homeDir,
      workspaceDir,
    }).resolve();

    expect(resolution.storageName).toBe("projects_app_12345678");
    expect(await readFile(join(baseStorageDir, "workspace.json"), "utf8")).toBe("{not-json");
  });

  it("throws when an injected digest maps two workspaces to the same owned hash directory", async () => {
    const { homeDir, root } = await createFixture();
    const first = join(root, "one", "projects", "app");
    const second = join(root, "two", "projects", "app");
    const third = join(root, "three", "projects", "app");
    await Promise.all(
      [first, second, third].map((workspaceDir) => mkdir(workspaceDir, { recursive: true })),
    );
    await new WorkspaceStorageLocator({ homeDir, workspaceDir: first }).resolve();
    await new WorkspaceStorageLocator({
      digest: () => "deadbeef",
      homeDir,
      workspaceDir: second,
    }).resolve();

    await expect(
      new WorkspaceStorageLocator({
        digest: () => "deadbeef",
        homeDir,
        workspaceDir: third,
      }).resolve(),
    ).rejects.toThrow("Workspace storage hash collision: projects_app_deadbeef.");
  });
});

async function createFixture(): Promise<{ homeDir: string; root: string }> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-workspace-storage-"));
  temporaryDirectories.push(directory);
  const homeDir = join(directory, "home");
  const root = join(directory, "root");
  await Promise.all([mkdir(homeDir), mkdir(root)]);
  return { homeDir, root };
}
