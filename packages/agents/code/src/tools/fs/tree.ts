import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PathBoundary } from "../common/path-boundary.js";
import { compareDirectoryEntries, shouldIgnoreEntry } from "./ignore.js";
import { DEFAULT_FS_MAX_ENTRIES, DEFAULT_TREE_MAX_DEPTH, type FsTreeOptions } from "./types.js";

export async function buildDirectoryTree(options: FsTreeOptions = {}): Promise<string> {
  const pathBoundary = new PathBoundary(options);
  const rootPath = await pathBoundary.resolveExistingPath(options.path ?? ".");
  const stat = await fs.stat(rootPath);

  if (!stat.isDirectory()) {
    throw new Error("path must reference a directory.");
  }

  const state = {
    count: 0,
    maxDepth: options.maxDepth ?? DEFAULT_TREE_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_FS_MAX_ENTRIES,
    truncated: false,
  };
  const lines = [pathBoundary.relative(rootPath) || "."];
  await appendTree(rootPath, "", 0, lines, options, state);

  if (state.truncated) {
    lines.push(`[truncated after ${state.maxEntries} entries]`);
  }

  return lines.join("\n");
}

async function appendTree(
  directoryPath: string,
  prefix: string,
  depth: number,
  lines: string[],
  options: FsTreeOptions,
  state: {
    count: number;
    maxDepth: number;
    maxEntries: number;
    truncated: boolean;
  },
): Promise<void> {
  if (depth >= state.maxDepth || state.truncated) {
    return;
  }

  const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => !shouldIgnoreEntry(entry, options))
    .sort(compareDirectoryEntries);

  for (const [index, entry] of entries.entries()) {
    if (state.count >= state.maxEntries) {
      state.truncated = true;

      return;
    }

    const isLast = index === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const nextPrefix = `${prefix}${isLast ? "    " : "|   "}`;
    lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    state.count += 1;

    if (entry.isDirectory()) {
      await appendTree(
        join(directoryPath, entry.name),
        nextPrefix,
        depth + 1,
        lines,
        options,
        state,
      );
    }
  }
}
