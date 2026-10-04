import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PathBoundary } from "../common/path-boundary.js";
import { requireNonEmpty } from "../common/validation.js";
import { compareDirectoryEntries, shouldIgnoreEntry } from "./ignore.js";
import { DEFAULT_FS_MAX_RESULTS, type FsGrepOptions } from "./types.js";

export async function grepFiles(options: FsGrepOptions): Promise<string> {
  const pattern = requireNonEmpty(options.pattern, "pattern is required.");
  const pathBoundary = new PathBoundary(options);
  const searchPath = await pathBoundary.resolveExistingPath(options.path ?? ".");
  const stat = await fs.stat(searchPath);
  const files = stat.isDirectory() ? await collectFiles(searchPath, options) : [searchPath];
  const results: string[] = [];
  const maxResults = options.maxResults ?? DEFAULT_FS_MAX_RESULTS;
  const normalizedPattern = options.caseSensitive === false ? pattern.toLowerCase() : pattern;

  for (const filePath of files) {
    if (results.length >= maxResults) {
      break;
    }

    await appendFileMatches({
      filePath,
      maxResults,
      normalizedPattern,
      options,
      pathBoundary,
      results,
    });
  }

  if (results.length === 0) {
    return "No matches found.";
  }

  return results.length >= maxResults
    ? [...results, `[truncated after ${maxResults} matches]`].join("\n")
    : results.join("\n");
}

async function collectFiles(directoryPath: string, options: FsGrepOptions): Promise<string[]> {
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => !shouldIgnoreEntry(entry, options))
    .sort(compareDirectoryEntries);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, options)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function appendFileMatches(input: {
  readonly filePath: string;
  readonly maxResults: number;
  readonly normalizedPattern: string;
  readonly options: FsGrepOptions;
  readonly pathBoundary: PathBoundary;
  readonly results: string[];
}): Promise<void> {
  let fileText: string;

  try {
    fileText = await fs.readFile(input.filePath, "utf8");
  } catch {
    return;
  }

  const lines = fileText.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (input.results.length >= input.maxResults) {
      return;
    }

    const searchableLine = input.options.caseSensitive === false ? line.toLowerCase() : line;
    const column = searchableLine.indexOf(input.normalizedPattern);

    if (column === -1) {
      continue;
    }

    input.results.push(
      `${input.pathBoundary.relative(input.filePath)}:${index + 1}:${column + 1}: ${line}`,
    );
  }
}
