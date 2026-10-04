import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ignoreModule from "ignore";
import { FILE_COMPLETION_LIMIT, FILE_SEARCH_SCAN_LIMIT } from "./constants.js";

type Ignore = ReturnType<typeof ignoreModule.default>;

export interface DirectoryChild {
  readonly isDirectory: boolean;
  readonly name: string;
}

export type ReadDirectory = (absolutePath: string) => Promise<readonly DirectoryChild[]>;
export type ReadIgnoreFile = (absolutePath: string) => Promise<string>;

export interface FileEntry {
  readonly display: string;
  readonly insertValue: string;
  readonly isDirectory: boolean;
  readonly name: string;
}

export interface SearchWorkspaceEntriesOptions {
  readonly cwd: string;
  readonly limit?: number;
  readonly query: string;
  readonly readDirectory?: ReadDirectory;
  readonly readIgnoreFile?: ReadIgnoreFile;
  readonly scanLimit?: number;
}

interface RankedFileEntry extends FileEntry {
  readonly score: number;
}

const defaultReadDirectory: ReadDirectory = async (absolutePath) => {
  const dirents = await readdir(absolutePath, { withFileTypes: true });

  return dirents.map((dirent) => ({
    isDirectory: dirent.isDirectory(),
    name: dirent.name,
  }));
};
const defaultReadIgnoreFile: ReadIgnoreFile = (absolutePath) => readFile(absolutePath, "utf8");

export async function searchWorkspaceEntries(
  options: SearchWorkspaceEntriesOptions,
): Promise<readonly FileEntry[]> {
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const ignoreRules = await loadIgnoreRules(
    options.cwd,
    options.readIgnoreFile ?? defaultReadIgnoreFile,
  );
  const limit = options.limit ?? FILE_COMPLETION_LIMIT;
  const query = normalizeQuery(options.query);

  if (!query) {
    return readTopLevelEntries(options.cwd, readDirectory, ignoreRules, limit);
  }

  const scanLimit = options.scanLimit ?? FILE_SEARCH_SCAN_LIMIT;
  const queue: { readonly absolutePath: string; readonly relativePath: string }[] = [
    {
      absolutePath: options.cwd,
      relativePath: "",
    },
  ];
  const rankedEntries: RankedFileEntry[] = [];
  let scannedEntries = 0;

  while (queue.length > 0 && scannedEntries < scanLimit) {
    const directory = queue.shift();

    if (!directory) {
      break;
    }

    let children: readonly DirectoryChild[];

    try {
      children = await readDirectory(directory.absolutePath);
    } catch {
      continue;
    }

    for (const child of [...children].sort(compareEntries)) {
      const entry = toFileEntry(child, directory.relativePath);
      if (!isVisibleEntry(entry, ignoreRules) || scannedEntries >= scanLimit) {
        continue;
      }

      scannedEntries += 1;
      const score = scoreFileEntry(entry, query);

      if (score !== undefined) {
        rankedEntries.push({ ...entry, score });
      }

      if (child.isDirectory) {
        queue.push({
          absolutePath: join(directory.absolutePath, child.name),
          relativePath: entry.insertValue,
        });
      }
    }
  }

  return rankedEntries.sort(compareRankedEntries).slice(0, limit);
}

export function splitQuery(query: string): { base: string; dirPrefix: string } {
  const lastSlashIndex = query.lastIndexOf("/");

  if (lastSlashIndex < 0) {
    return { base: query, dirPrefix: "" };
  }

  return {
    base: query.slice(lastSlashIndex + 1),
    dirPrefix: query.slice(0, lastSlashIndex + 1),
  };
}

async function readTopLevelEntries(
  cwd: string,
  readDirectory: ReadDirectory,
  ignoreRules: Ignore | undefined,
  limit: number,
): Promise<readonly FileEntry[]> {
  try {
    return [...(await readDirectory(cwd))]
      .sort(compareEntries)
      .map((child) => toFileEntry(child, ""))
      .filter((entry) => isVisibleEntry(entry, ignoreRules))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/^\.\//u, "").toLowerCase();
}

function isVisibleEntry(entry: FileEntry, ignoreRules: Ignore | undefined): boolean {
  return (
    !entry.name.startsWith(".") &&
    entry.name !== "node_modules" &&
    ignoreRules?.ignores(entry.insertValue) !== true
  );
}

function toFileEntry(child: DirectoryChild, dirPrefix: string): FileEntry {
  const suffix = child.isDirectory ? "/" : "";
  const insertValue = `${dirPrefix}${child.name}${suffix}`;

  return {
    display: insertValue,
    insertValue,
    isDirectory: child.isDirectory,
    name: child.name,
  };
}

function scoreFileEntry(entry: FileEntry, query: string): number | undefined {
  const path = entry.insertValue.toLowerCase();
  const pathWithoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const name = entry.name.toLowerCase();
  const queryWithoutSlash = query.endsWith("/") ? query.slice(0, -1) : query;

  if (path === query && entry.isDirectory) {
    return undefined;
  }

  if (name === queryWithoutSlash) {
    return 10_000 - path.length;
  }

  if (path.startsWith(query)) {
    return 9_500 - path.length;
  }

  if (name.startsWith(queryWithoutSlash)) {
    return 9_000 - name.length - getPathDepth(path) * 10;
  }

  const segmentIndex = pathWithoutSlash
    .split("/")
    .findIndex((segment) => segment.startsWith(queryWithoutSlash));

  if (segmentIndex >= 0) {
    return 8_000 - segmentIndex * 100 - path.length;
  }

  const nameIndex = name.indexOf(queryWithoutSlash);

  if (nameIndex >= 0) {
    return 7_000 - nameIndex * 100 - path.length;
  }

  const pathIndex = path.indexOf(query);

  if (pathIndex >= 0) {
    return 6_000 - pathIndex * 10 - path.length;
  }

  const subsequenceScore = scoreSubsequence(pathWithoutSlash, queryWithoutSlash);

  return subsequenceScore === undefined
    ? undefined
    : 1_000 + subsequenceScore - getPathDepth(path) * 10;
}

function scoreSubsequence(candidate: string, query: string): number | undefined {
  let candidateIndex = 0;
  let previousMatchIndex = -2;
  let score = 0;

  for (const queryCharacter of query) {
    const matchIndex = candidate.indexOf(queryCharacter, candidateIndex);

    if (matchIndex < 0) {
      return undefined;
    }

    if (matchIndex === previousMatchIndex + 1) {
      score += 20;
    }

    if (matchIndex === 0 || candidate.charAt(matchIndex - 1) === "/") {
      score += 30;
    }

    score -= matchIndex - candidateIndex;
    previousMatchIndex = matchIndex;
    candidateIndex = matchIndex + 1;
  }

  return score;
}

function getPathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function compareRankedEntries(left: RankedFileEntry, right: RankedFileEntry): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }

  return left.insertValue.localeCompare(right.insertValue);
}

function compareEntries(left: DirectoryChild, right: DirectoryChild): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

async function loadIgnoreRules(
  cwd: string,
  readIgnoreFile: ReadIgnoreFile,
): Promise<Ignore | undefined> {
  try {
    return ignoreModule.default().add(await readIgnoreFile(join(cwd, ".gitignore")));
  } catch {
    return undefined;
  }
}
