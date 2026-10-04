import type { Dirent } from "node:fs";

const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

export interface IgnoreOptions {
  readonly includeHidden?: boolean | undefined;
}

export function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

export function shouldIgnoreEntry(entry: Dirent, options: IgnoreOptions = {}): boolean {
  if (!options.includeHidden && entry.name.startsWith(".")) {
    return true;
  }

  return DEFAULT_IGNORED_NAMES.has(entry.name);
}
