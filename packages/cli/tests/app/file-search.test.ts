import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type DirectoryChild,
  searchWorkspaceEntries,
  splitQuery,
} from "../../src/app/file-search.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const workspaceTree: Record<string, readonly DirectoryChild[]> = {
  "/workspace": [
    { isDirectory: true, name: "packages" },
    { isDirectory: true, name: "playground" },
    { isDirectory: true, name: "node_modules" },
    { isDirectory: false, name: "README.md" },
    { isDirectory: false, name: "package.json" },
    { isDirectory: true, name: ".git" },
  ],
  "/workspace/packages": [
    { isDirectory: true, name: "cli" },
    { isDirectory: true, name: "config" },
  ],
  "/workspace/packages/cli": [
    { isDirectory: true, name: "src" },
    { isDirectory: false, name: "README.md" },
  ],
  "/workspace/packages/cli/src": [
    { isDirectory: false, name: "completion.ts" },
    { isDirectory: false, name: "trace.ts" },
  ],
  "/workspace/packages/config": [],
  "/workspace/playground": [],
};

function createReadDirectory() {
  return vi.fn(async (absolutePath: string): Promise<readonly DirectoryChild[]> => {
    const children = workspaceTree[absolutePath];

    if (!children) {
      throw new Error(`ENOENT: ${absolutePath}`);
    }

    return children;
  });
}

describe("splitQuery", () => {
  it("returns the base when there is no directory prefix", () => {
    expect(splitQuery("pack")).toEqual({ base: "pack", dirPrefix: "" });
  });

  it("splits the directory prefix from the base", () => {
    expect(splitQuery("packages/cl")).toEqual({ base: "cl", dirPrefix: "packages/" });
  });

  it("keeps an empty base when the query ends with a slash", () => {
    expect(splitQuery("packages/")).toEqual({ base: "", dirPrefix: "packages/" });
  });
});

describe("searchWorkspaceEntries", () => {
  it("lists directories first and hides dotfiles", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "",
      readDirectory: createReadDirectory(),
    });

    expect(entries.map((entry) => entry.insertValue)).toEqual([
      "packages/",
      "playground/",
      "package.json",
      "README.md",
    ]);
  });

  it("filters entries by the base query case-insensitively", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "pack",
      readDirectory: createReadDirectory(),
    });

    expect(entries.map((entry) => entry.insertValue).slice(0, 2)).toEqual([
      "packages/",
      "package.json",
    ]);
  });

  it("applies root .gitignore rules to files and directory traversal", async () => {
    const readDirectory = vi.fn(async (absolutePath: string) => {
      if (absolutePath === "/workspace") {
        return [
          { isDirectory: true, name: "build" },
          { isDirectory: false, name: "debug.log" },
          { isDirectory: false, name: "keep.log" },
        ];
      }
      if (absolutePath === "/workspace/build") {
        return [{ isDirectory: false, name: "generated.ts" }];
      }
      throw new Error(`ENOENT: ${absolutePath}`);
    });
    const readIgnoreFile = vi.fn(async () => ["build/", "*.log", "!keep.log"].join("\n"));
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "g",
      readDirectory,
      readIgnoreFile,
    });

    expect(entries.map((entry) => entry.insertValue)).toContain("keep.log");
    expect(entries.map((entry) => entry.insertValue)).not.toContain("debug.log");
    expect(entries.map((entry) => entry.insertValue)).not.toContain("build/");
    expect(readDirectory).not.toHaveBeenCalledWith("/workspace/build");
    expect(readIgnoreFile).toHaveBeenCalledWith("/workspace/.gitignore");
  });

  it("falls back to built-in filtering when .gitignore cannot be read", async () => {
    const readDirectory = vi.fn(async () => [{ isDirectory: false, name: "debug.log" }]);
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "debug",
      readDirectory,
      readIgnoreFile: async () => {
        throw new Error("ENOENT");
      },
    });

    expect(entries.map((entry) => entry.insertValue)).toContain("debug.log");
  });

  it("descends into a directory prefix", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "packages/c",
      readDirectory: createReadDirectory(),
    });

    expect(entries.map((entry) => entry.insertValue).slice(0, 2)).toEqual([
      "packages/cli/",
      "packages/config/",
    ]);
  });

  it("finds and ranks recursive fuzzy path matches", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "cltr",
      readDirectory: createReadDirectory(),
    });

    expect(entries.map((entry) => entry.insertValue)).toContain("packages/cli/src/trace.ts");
  });

  it("does not traverse hidden or dependency directories", async () => {
    const readDirectory = createReadDirectory();

    await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "dependency",
      readDirectory,
    });

    expect(readDirectory).not.toHaveBeenCalledWith("/workspace/.git");
    expect(readDirectory).not.toHaveBeenCalledWith("/workspace/node_modules");
  });

  it("bounds recursive scanning", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "trace",
      readDirectory: createReadDirectory(),
      scanLimit: 2,
    });

    expect(entries).toEqual([]);
  });

  it("applies the result limit", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      limit: 2,
      query: "",
      readDirectory: createReadDirectory(),
    });

    expect(entries).toHaveLength(2);
  });

  it("returns an empty list when the directory cannot be read", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: "/workspace",
      query: "missing/thing",
      readDirectory: createReadDirectory(),
    });

    expect(entries).toEqual([]);
  });

  it("reads the real filesystem with the default reader", async () => {
    const entries = await searchWorkspaceEntries({
      cwd: resolve(currentDir, "../../src"),
      query: "app/comple",
    });

    expect(entries.map((entry) => entry.insertValue)).toContain("app/completion.ts");
  });
});
