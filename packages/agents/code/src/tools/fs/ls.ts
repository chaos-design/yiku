import { promises as fs } from "node:fs";
import { PathBoundary } from "../common/path-boundary.js";
import { compareDirectoryEntries, shouldIgnoreEntry } from "./ignore.js";
import { DEFAULT_FS_MAX_ENTRIES, type FsListOptions } from "./types.js";

export async function listDirectory(options: FsListOptions = {}): Promise<string> {
  const pathBoundary = new PathBoundary(options);
  const directoryPath = await pathBoundary.resolveExistingPath(options.path ?? ".");
  const stat = await fs.stat(directoryPath);

  if (!stat.isDirectory()) {
    throw new Error("path must reference a directory.");
  }

  const maxEntries = options.maxEntries ?? DEFAULT_FS_MAX_ENTRIES;
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => !shouldIgnoreEntry(entry, options))
    .sort(compareDirectoryEntries);
  const visibleEntries = entries.slice(0, maxEntries);
  const lines = visibleEntries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  const truncation = entries.length > maxEntries ? [`[truncated after ${maxEntries} entries]`] : [];

  return [`Directory ${pathBoundary.relative(directoryPath)}:`, ...lines, ...truncation].join("\n");
}
