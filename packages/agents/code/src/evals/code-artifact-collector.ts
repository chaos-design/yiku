import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  type AgentArtifactRef,
  EvaluationError,
  sha256Digest,
  sha256Text,
  utf8ByteLength,
} from "@yiku/evals";
import type {
  CodeArtifactCollectorOptions,
  CodeArtifactScope,
  CodeSnapshotEntry,
  CodeWorkspaceSnapshot,
} from "./types.js";

const DEFAULT_EXCLUDES = Object.freeze([".git", "coverage", "dist", "node_modules"]);
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export class CodeArtifactCollector {
  private readonly allowedPaths: readonly string[];
  private readonly deniedPaths: readonly string[];
  private readonly exclude: readonly string[];
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly options: CodeArtifactCollectorOptions;

  public constructor(options: CodeArtifactCollectorOptions) {
    this.options = options;
    this.allowedPaths = normalizeScope(options.allowedPaths ?? [""]);
    this.deniedPaths = normalizeScope(options.deniedPaths ?? []);
    this.exclude = normalizeScope(options.exclude ?? DEFAULT_EXCLUDES);
    this.maxFiles = positiveInteger(
      options.maxFiles ?? DEFAULT_MAX_FILES,
      "Code snapshot max files",
    );
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      "Code snapshot max total bytes",
    );
  }

  public async capture(): Promise<CodeWorkspaceSnapshot> {
    const entries: CodeSnapshotEntry[] = [];
    let totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const children = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const child of children) {
        const fullPath = resolve(directory, child.name);
        const path = relativePath(this.options.workspace.rootDir, fullPath);
        if (isUnder(path, this.exclude)) {
          continue;
        }
        if (child.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        if (!child.isFile() && !child.isSymbolicLink()) {
          continue;
        }
        if (entries.length >= this.maxFiles) {
          throw new EvaluationError(
            "EVAL_INPUT_TOO_LARGE",
            `Code snapshot exceeded ${this.maxFiles} entries.`,
          );
        }
        const entry = child.isSymbolicLink()
          ? await this.captureSymlink(path, fullPath)
          : await this.captureFile(path, fullPath);
        totalBytes += entry.sizeBytes;
        if (totalBytes > this.maxTotalBytes) {
          throw new EvaluationError(
            "EVAL_INPUT_TOO_LARGE",
            `Code snapshot exceeded ${this.maxTotalBytes} bytes.`,
          );
        }
        entries.push(entry);
      }
    };
    await visit(this.options.workspace.rootDir);
    const semantic = {
      entries,
      totalBytes,
      version: 1 as const,
    };
    return Object.freeze({
      ...semantic,
      digest: sha256Digest(semantic, {
        code: "EVAL_INVALID_RESULT",
        label: "Code workspace snapshot",
      }),
      entries: Object.freeze(entries),
    });
  }

  public compare(
    before: CodeWorkspaceSnapshot,
    after: CodeWorkspaceSnapshot,
  ): readonly AgentArtifactRef[] {
    validateSnapshot(before);
    validateSnapshot(after);
    const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
    const current = new Map(after.entries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...previous.keys(), ...current.keys()])].toSorted();

    return Object.freeze(
      paths.flatMap((path) => {
        const oldEntry = previous.get(path);
        const newEntry = current.get(path);
        if (
          oldEntry?.digest === newEntry?.digest &&
          oldEntry?.mode === newEntry?.mode &&
          oldEntry?.type === newEntry?.type
        ) {
          return [];
        }
        const changeType =
          oldEntry === undefined ? "added" : newEntry === undefined ? "deleted" : "modified";
        const semantic = {
          afterDigest: newEntry?.digest ?? "",
          beforeDigest: oldEntry?.digest ?? "",
          changeType,
          externalSymlink: newEntry?.external ?? oldEntry?.external ?? false,
          inScope: this.inScope(path),
          mode: newEntry?.mode ?? oldEntry?.mode ?? 0,
          path,
          type: newEntry?.type ?? oldEntry?.type ?? "file",
        };
        return [
          Object.freeze({
            digest: sha256Digest(semantic, {
              code: "EVAL_INVALID_RESULT",
              label: `Code artifact ${path}`,
            }),
            id: `file-${sha256Text(path)}`,
            kind: "file-change" as const,
            metadata: Object.freeze(semantic),
            sizeBytes: newEntry?.sizeBytes ?? oldEntry?.sizeBytes ?? 0,
            storageRef: `workspace:${path}`,
          }),
        ];
      }),
    );
  }

  private async captureFile(path: string, fullPath: string): Promise<CodeSnapshotEntry> {
    const before = await lstat(fullPath);
    if (!before.isFile()) {
      throw new EvaluationError(
        "EVAL_ARTIFACT_CHANGED",
        `Code artifact changed type during capture: ${path}.`,
      );
    }
    if (before.size > this.maxTotalBytes) {
      throw new EvaluationError(
        "EVAL_INPUT_TOO_LARGE",
        `Code artifact ${path} exceeds the snapshot byte limit.`,
      );
    }
    const contents = await readFile(fullPath);
    const after = await lstat(fullPath);
    if (
      !after.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new EvaluationError(
        "EVAL_ARTIFACT_CHANGED",
        `Code artifact changed during capture: ${path}.`,
      );
    }
    return Object.freeze({
      digest: createHash("sha256").update(contents).digest("hex"),
      external: false,
      mode: after.mode & 0o777,
      path,
      sizeBytes: contents.byteLength,
      type: "file",
    });
  }

  private async captureSymlink(path: string, fullPath: string): Promise<CodeSnapshotEntry> {
    const target = await readlink(fullPath);
    let external = true;
    try {
      external = !this.options.workspace.containsPath(await realpath(fullPath));
    } catch {
      external = true;
    }
    return Object.freeze({
      digest: sha256Text(target),
      external,
      mode: (await lstat(fullPath)).mode & 0o777,
      path,
      sizeBytes: utf8ByteLength(target),
      type: "symlink",
    });
  }

  private inScope(path: string): boolean {
    return isUnder(path, this.allowedPaths) && !isUnder(path, this.deniedPaths);
  }
}

function validateSnapshot(snapshot: CodeWorkspaceSnapshot): void {
  if (
    snapshot.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(snapshot.digest) ||
    !Number.isSafeInteger(snapshot.totalBytes) ||
    snapshot.totalBytes < 0
  ) {
    throw new EvaluationError("EVAL_INVALID_RESULT", "Code workspace snapshot is invalid.");
  }
  const semantic = {
    entries: snapshot.entries,
    totalBytes: snapshot.totalBytes,
    version: snapshot.version,
  };
  if (
    sha256Digest(semantic, {
      code: "EVAL_INVALID_RESULT",
      label: "Code workspace snapshot",
    }) !== snapshot.digest
  ) {
    throw new EvaluationError(
      "EVAL_INVALID_RESULT",
      "Code workspace snapshot digest does not match its contents.",
    );
  }
}

function normalizeScope(paths: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(paths.map(normalizeRelativePath))].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  );
}

function normalizeRelativePath(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .replaceAll(/^\.\/+/gu, "")
    .replaceAll(/\/+$/gu, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Code artifact scope must be a normalized relative path: ${path}.`,
    );
  }
  return normalized;
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (value === ".." || value.startsWith(`..${sep}`)) {
    throw new EvaluationError(
      "EVAL_ARTIFACT_CHANGED",
      "Code artifact escaped the workspace during capture.",
    );
  }
  return value.split(sep).join("/");
}

function isUnder(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`),
  );
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EvaluationError("EVAL_PROFILE_INVALID", `${label} must be a positive integer.`);
  }
  return value;
}

export type { CodeArtifactScope };
