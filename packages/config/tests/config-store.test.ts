import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigRevisionConflictError, ConfigStore } from "../src/config-store.js";
import { serializeModelsConfig } from "../src/models.js";

const fsMocks = vi.hoisted(() => ({
  rename: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.rename.mockImplementation(actual.rename);
  return {
    ...actual,
    rename: fsMocks.rename,
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  fsMocks.rename.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ConfigStore", () => {
  it("requires an absolute file path", () => {
    expect(() => new ConfigStore({ filePath: "config.yaml" })).toThrow(
      "ConfigStore filePath must be absolute.",
    );
  });

  it("loads an empty config when the file is missing and creates it on set", async () => {
    const root = await createTempDir();
    const filePath = join(root, "nested", "config.yaml");
    const store = new ConfigStore({ filePath });

    await expect(store.load()).resolves.toEqual({});
    await expect(store.set(["models", "default"], "code")).resolves.toEqual({
      models: {
        default: "code",
      },
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe(
      serializeModelsConfig({
        models: {
          default: "code",
        },
      }),
    );
  });

  it("preserves unrelated values and sibling nested values", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    await writeFile(
      filePath,
      serializeModelsConfig({
        models: {
          default: "old",
          items: {
            code: {
              name: "existing",
            },
          },
        },
        unrelated: {
          enabled: true,
        },
      }),
    );

    const result = await new ConfigStore({ filePath }).set(
      ["models", "items", "code", "name"],
      "updated",
    );

    expect(result).toEqual({
      models: {
        default: "old",
        items: {
          code: {
            name: "updated",
          },
        },
      },
      unrelated: {
        enabled: true,
      },
    });
  });

  it("rejects empty path segments", async () => {
    const filePath = join(await createTempDir(), "config.yaml");
    const store = new ConfigStore({ filePath });

    await expect(store.set([], true)).rejects.toThrow(
      "ConfigStore path must contain non-empty segments.",
    );
    await expect(store.set(["models", "  "], true)).rejects.toThrow(
      "ConfigStore path must contain non-empty segments.",
    );
  });

  it("rejects traversal through a non-record without changing the file", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    const original = "models: disabled\nunrelated: preserved\n";
    await writeFile(filePath, original);

    await expect(new ConfigStore({ filePath }).set(["models", "default"], "code")).rejects.toThrow(
      'Config path cannot traverse non-record segment: ["models"]',
    );
    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
  });

  it("commits config files with mode 0600", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    await writeFile(filePath, "existing: true\n", { mode: 0o644 });

    await new ConfigStore({ filePath }).set(["added"], true);

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("detects source changes before commit and preserves the external update", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    await writeFile(filePath, "value: original\n");
    const store = new ConfigStore({
      beforeCommit: async () => {
        await writeFile(filePath, "value: external\n");
      },
      filePath,
    });

    await expect(store.set(["value"], "store")).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    await expect(readFile(filePath, "utf8")).resolves.toBe("value: external\n");
    expect(await readdir(root)).toEqual(["config.yaml"]);
  });

  it("cleans the temporary file when rename fails", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    const original = "value: original\n";
    await writeFile(filePath, original);
    fsMocks.rename.mockRejectedValueOnce(
      Object.assign(new Error("rename failed"), {
        code: "EIO",
      }),
    );

    await expect(new ConfigStore({ filePath }).set(["value"], "updated")).rejects.toThrow(
      "rename failed",
    );
    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
    expect(await readdir(root)).toEqual(["config.yaml"]);
  });

  it("serializes operations from the same instance", async () => {
    const root = await createTempDir();
    const filePath = join(root, "config.yaml");
    const firstCommitStarted = deferred();
    const releaseFirstCommit = deferred();
    let commitCount = 0;
    const store = new ConfigStore({
      beforeCommit: async () => {
        commitCount += 1;
        if (commitCount === 1) {
          firstCommitStarted.resolve();
          await releaseFirstCommit.promise;
        }
      },
      filePath,
    });

    const first = store.set(["first"], 1);
    await firstCommitStarted.promise;
    const second = store.set(["second"], 2);
    await Promise.resolve();
    expect(commitCount).toBe(1);

    releaseFirstCommit.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { first: 1 },
      { first: 1, second: 2 },
    ]);
    await expect(store.load()).resolves.toEqual({
      first: 1,
      second: 2,
    });
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-config-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
