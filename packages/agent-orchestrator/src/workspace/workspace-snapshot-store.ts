import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isErrorCode, isNotFoundError, syncDirectory } from "../filesystem.js";
import {
  parseWorkspaceSnapshotManifest,
  WORKSPACE_SNAPSHOT_MANIFEST_VERSION,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotManifest,
} from "./snapshot-types.js";

export const DEFAULT_WORKSPACE_SNAPSHOT_LIMITS = Object.freeze({
  bytes: 1024 * 1024 * 1024,
  files: 100_000,
});

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  "coverage",
  "dist",
  "dist-client",
  "dist-server",
  "node_modules",
]);

export interface WorkspaceSnapshotLimits {
  readonly bytes?: number | undefined;
  readonly files?: number | undefined;
}

export interface WorkspaceSnapshotStoreOptions {
  readonly beforeApplyEntry?:
    | ((path: string, index: number, phase: "rollback" | "target") => Promise<void> | void)
    | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly limits?: WorkspaceSnapshotLimits | undefined;
  readonly storageDir: string;
  readonly workspaceDir: string;
}

export interface CaptureWorkspaceSnapshotInput {
  readonly eventHead?: string | undefined;
  readonly sessionId: string;
  readonly sessionRevision: number;
}

type WorkspaceSnapshotLimitKind = "bytes" | "files";

export class WorkspaceSnapshotLimitError extends Error {
  public override readonly name = "WorkspaceSnapshotLimitError";

  public constructor(
    public readonly kind: WorkspaceSnapshotLimitKind,
    public readonly actual: number,
    public readonly maximum: number,
  ) {
    super(`Workspace snapshot exceeds the ${kind} limit: ${actual} > ${maximum}.`);
  }
}

interface SnapshotFile {
  readonly absolutePath: string;
  readonly path: string;
}

interface WorkspaceTree {
  readonly directories: readonly SnapshotFile[];
  readonly files: readonly SnapshotFile[];
}

interface PersistedBlob {
  readonly hash: string;
  readonly mode: number;
  readonly size: number;
}

interface RestoreJournal {
  readonly backupManifest: WorkspaceSnapshotManifest;
  readonly status: "applying" | "committed";
  readonly targetId: string;
}

interface RestoreJournalEnvelope {
  readonly backupManifest: unknown;
  readonly status: "applying" | "committed";
  readonly targetId: string;
}

interface ResolvedWorkspaceSnapshotLimits {
  readonly bytes: number;
  readonly files: number;
}

export class WorkspaceSnapshotStore {
  private readonly beforeApplyEntry:
    | ((path: string, index: number, phase: "rollback" | "target") => Promise<void> | void)
    | undefined;
  private readonly blobsDir: string;
  private readonly excludedPaths: readonly string[];
  private readonly limits: ResolvedWorkspaceSnapshotLimits;
  private readonly manifestsDir: string;
  private readonly storageDir: string;
  private readonly transactionsDir: string;
  private readonly workspaceDir: string;

  public constructor(options: WorkspaceSnapshotStoreOptions) {
    if (!isAbsolute(options.workspaceDir) || !isAbsolute(options.storageDir)) {
      throw new Error("Workspace snapshot directories must be absolute.");
    }

    this.workspaceDir = resolve(options.workspaceDir);
    this.storageDir = resolve(options.storageDir);
    if (this.workspaceDir === this.storageDir) {
      throw new Error("Workspace snapshot storage must not be the workspace root.");
    }

    this.blobsDir = join(this.storageDir, "blobs");
    this.manifestsDir = join(this.storageDir, "manifests");
    this.transactionsDir = join(this.storageDir, "transactions");
    this.beforeApplyEntry = options.beforeApplyEntry;
    this.limits = {
      bytes: requireLimit(options.limits?.bytes, DEFAULT_WORKSPACE_SNAPSHOT_LIMITS.bytes, "bytes"),
      files: requireLimit(options.limits?.files, DEFAULT_WORKSPACE_SNAPSHOT_LIMITS.files, "files"),
    };

    const excludedPaths = (options.exclude ?? []).map(normalizeExcludedPath);
    const storagePath = relative(this.workspaceDir, this.storageDir);
    if (isInside(this.workspaceDir, this.storageDir) && storagePath) {
      excludedPaths.push(toPosixPath(storagePath));
    }
    this.excludedPaths = Object.freeze(excludedPaths);
  }

  public async capture(input: CaptureWorkspaceSnapshotInput): Promise<WorkspaceSnapshotManifest> {
    requireCaptureInput(input);
    const manifest = await this.captureManifest(input, randomUUID());
    await this.persistManifest(manifest);
    return manifest;
  }

  public async load(id: string): Promise<WorkspaceSnapshotManifest> {
    const normalizedId = requireSnapshotId(id);
    const manifest = parseWorkspaceSnapshotManifest(
      JSON.parse(await fs.readFile(this.manifestPath(normalizedId), "utf8")),
    );
    if (manifest.id !== normalizedId) {
      throw new Error(`Workspace snapshot manifest ID does not match: ${normalizedId}.`);
    }
    return manifest;
  }

  public async remove(id: string): Promise<void> {
    await fs.rm(this.manifestPath(requireSnapshotId(id)), { force: true });
  }

  public async recover(): Promise<void> {
    await this.recoverTransactions();
  }

  public async restore(id: string): Promise<void> {
    await this.recoverTransactions();

    const target = await this.load(requireSnapshotId(id));
    await this.validateManifestForApply(target);

    const transactionId = randomUUID();
    const transactionDir = join(this.transactionsDir, transactionId);
    await ensurePrivateDirectory(transactionDir);

    let backup: WorkspaceSnapshotManifest;
    try {
      backup = await this.captureManifest(
        {
          sessionId: "__restore__",
          sessionRevision: 0,
        },
        transactionId,
      );
      await writeAtomicFile(
        join(transactionDir, "backup.json"),
        `${JSON.stringify(backup, null, 2)}\n`,
      );
    } catch (error) {
      await this.cleanupTransaction(transactionDir).catch(() => undefined);
      throw error;
    }

    const journal: RestoreJournal = {
      backupManifest: backup,
      status: "applying",
      targetId: target.id,
    };
    await this.persistJournal(transactionDir, journal);

    try {
      await this.applyManifest(target, "target");
      await this.persistJournal(transactionDir, { ...journal, status: "committed" });
    } catch (applyError) {
      try {
        await this.applyManifest(backup, "rollback");
      } catch (rollbackError) {
        throw new AggregateError(
          [applyError, rollbackError],
          `Workspace snapshot restore and rollback failed: ${target.id}.`,
        );
      }

      try {
        await this.cleanupTransaction(transactionDir);
      } catch (cleanupError) {
        throw new AggregateError(
          [applyError, cleanupError],
          `Workspace snapshot restore failed and transaction cleanup failed: ${target.id}.`,
        );
      }
      throw applyError;
    }

    await this.cleanupTransaction(transactionDir);
  }

  private async applyManifest(
    manifest: WorkspaceSnapshotManifest,
    phase: "rollback" | "target",
  ): Promise<void> {
    await this.validateManifestForApply(manifest);
    const tree = await this.collectWorkspaceTree(false);
    const targetPaths = new Set(manifest.entries.map((entry) => entry.path));

    for (const file of tree.files) {
      if (!targetPaths.has(file.path)) {
        await removeWorkspaceFile(file);
      }
    }
    for (const directory of tree.directories.toReversed()) {
      await removeEmptyWorkspaceDirectory(directory);
    }

    for (const [index, entry] of manifest.entries.entries()) {
      await this.beforeApplyEntry?.(entry.path, index, phase);
      await this.writeWorkspaceEntry(entry);
    }
  }

  private async captureManifest(
    input: CaptureWorkspaceSnapshotInput,
    id: string,
  ): Promise<WorkspaceSnapshotManifest> {
    const files = (await this.collectWorkspaceTree(true)).files;
    await this.prepareStorage();
    const entries: WorkspaceSnapshotEntry[] = [];
    let capturedBytes = 0;
    for (const file of files) {
      const blob = await this.persistBlob(file.absolutePath, this.limits.bytes - capturedBytes);
      capturedBytes += blob.size;
      entries.push({
        hash: blob.hash,
        mode: blob.mode,
        path: file.path,
        size: blob.size,
        type: "file",
      });
    }

    return parseWorkspaceSnapshotManifest({
      createdAt: new Date().toISOString(),
      entries,
      ...(input.eventHead === undefined ? {} : { eventHead: input.eventHead }),
      id,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      version: WORKSPACE_SNAPSHOT_MANIFEST_VERSION,
    });
  }

  private async cleanupTransaction(transactionDir: string): Promise<void> {
    await fs.rm(transactionDir, { force: true, recursive: true });
    await syncDirectory(this.transactionsDir);
  }

  private async collectWorkspaceTree(enforceLimits: boolean): Promise<WorkspaceTree> {
    const rootStat = await fs.lstat(this.workspaceDir);
    if (rootStat.isSymbolicLink()) {
      throw new Error("Workspace snapshot root must not be a symbolic link.");
    }
    if (!rootStat.isDirectory()) {
      throw new Error("Workspace snapshot root must be a directory.");
    }

    const directories: SnapshotFile[] = [];
    const files: SnapshotFile[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const names = (await fs.readdir(directory)).toSorted(compareText);
      for (const name of names) {
        const snapshotPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const absolutePath = join(directory, name);
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Workspace snapshot does not support symbolic links: ${snapshotPath}.`);
        }
        if (!stat.isFile() && !stat.isDirectory()) {
          throw new Error(`Workspace snapshot does not support special files: ${snapshotPath}.`);
        }
        if (this.isExcluded(snapshotPath)) {
          continue;
        }
        if (stat.isDirectory()) {
          directories.push({ absolutePath, path: snapshotPath });
          await visit(absolutePath, snapshotPath);
          continue;
        }

        files.push({ absolutePath, path: snapshotPath });
        if (enforceLimits && files.length > this.limits.files) {
          throw new WorkspaceSnapshotLimitError("files", files.length, this.limits.files);
        }
        totalBytes += stat.size;
        if (enforceLimits && totalBytes > this.limits.bytes) {
          throw new WorkspaceSnapshotLimitError("bytes", totalBytes, this.limits.bytes);
        }
      }
    };

    await visit(this.workspaceDir, "");
    return {
      directories: directories.toSorted((left, right) => compareText(left.path, right.path)),
      files: files.toSorted((left, right) => compareText(left.path, right.path)),
    };
  }

  private isExcluded(path: string): boolean {
    if (path.split("/").some((segment) => DEFAULT_EXCLUDED_NAMES.has(segment))) {
      return true;
    }

    return this.excludedPaths.some(
      (excludedPath) =>
        path === excludedPath ||
        path.startsWith(`${excludedPath}/`) ||
        (!excludedPath.includes("/") && path.split("/").includes(excludedPath)),
    );
  }

  private async prepareStorage(): Promise<void> {
    await ensurePrivateDirectory(this.storageDir);
    await ensurePrivateDirectory(this.blobsDir);
    await ensurePrivateDirectory(this.manifestsDir);
    await ensurePrivateDirectory(this.transactionsDir);
  }

  private async persistBlob(path: string, maximumBytes: number): Promise<PersistedBlob> {
    const temporaryPath = join(this.blobsDir, `.blob-${randomUUID()}.tmp`);
    let source: Awaited<ReturnType<typeof fs.open>> | undefined;
    let temporary: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      source = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const sourceStat = await source.stat();
      if (!sourceStat.isFile()) {
        throw new Error(`Workspace snapshot source is no longer a regular file: ${path}.`);
      }

      temporary = await fs.open(temporaryPath, "wx", 0o600);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;

      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          break;
        }
        size += bytesRead;
        if (size > maximumBytes) {
          throw new WorkspaceSnapshotLimitError(
            "bytes",
            this.limits.bytes - maximumBytes + size,
            this.limits.bytes,
          );
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await writeAll(temporary, chunk);
      }

      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await source.close();
      source = undefined;

      const digest = hash.digest("hex");
      const blobPath = join(this.blobsDir, digest);
      if (await pathExists(blobPath)) {
        const blobStat = await fs.lstat(blobPath);
        if (!blobStat.isFile() || blobStat.isSymbolicLink()) {
          throw new Error(`Workspace snapshot blob is not a regular file: ${digest}.`);
        }
        await fs.rm(temporaryPath, { force: true });
      } else {
        await fs.rename(temporaryPath, blobPath);
      }
      await fs.chmod(blobPath, 0o600);
      await syncDirectory(this.blobsDir);

      return {
        hash: digest,
        mode: sourceStat.mode & 0o777,
        size,
      };
    } finally {
      await source?.close().catch(() => undefined);
      await temporary?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async persistManifest(manifest: WorkspaceSnapshotManifest): Promise<void> {
    const path = this.manifestPath(manifest.id);
    await writeAtomicFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async persistJournal(transactionDir: string, journal: RestoreJournal): Promise<void> {
    await writeAtomicFile(
      join(transactionDir, "journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  }

  private async recoverTransactions(): Promise<void> {
    await this.prepareStorage();
    const names = (await fs.readdir(this.transactionsDir)).toSorted(compareText);
    for (const name of names) {
      requireSnapshotId(name);
      const transactionDir = join(this.transactionsDir, name);
      const transactionStat = await fs.lstat(transactionDir);
      if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
        throw new Error(`Workspace snapshot transaction is not a regular directory: ${name}.`);
      }

      const journalPath = join(transactionDir, "journal.json");
      if (!(await pathExists(journalPath))) {
        await this.cleanupTransaction(transactionDir);
        continue;
      }

      const envelope = parseRestoreJournalEnvelope(
        JSON.parse(await fs.readFile(journalPath, "utf8")),
      );
      if (envelope.status === "committed") {
        await this.cleanupTransaction(transactionDir);
        continue;
      }

      const backupManifest =
        envelope.backupManifest === "backup.json"
          ? parseWorkspaceSnapshotManifest(
              JSON.parse(await fs.readFile(join(transactionDir, "backup.json"), "utf8")),
            )
          : parseWorkspaceSnapshotManifest(envelope.backupManifest);
      await this.applyManifest(backupManifest, "rollback");
      await this.cleanupTransaction(transactionDir);
    }
  }

  private async validateBlob(entry: WorkspaceSnapshotEntry): Promise<void> {
    await this.consumeBlob(entry);
  }

  private async validateManifestForApply(manifest: WorkspaceSnapshotManifest): Promise<void> {
    const paths = new Set(manifest.entries.map((entry) => entry.path));
    for (const entry of manifest.entries) {
      if (this.isExcluded(entry.path)) {
        throw new Error(`Workspace snapshot entry uses an excluded path: ${entry.path}.`);
      }
      let parent = dirname(entry.path);
      while (parent !== ".") {
        if (paths.has(toPosixPath(parent))) {
          throw new Error(`Workspace snapshot entries have a file path conflict: ${entry.path}.`);
        }
        parent = dirname(parent);
      }
    }
    for (const entry of manifest.entries) {
      await this.validateBlob(entry);
    }
  }

  private async consumeBlob(
    entry: WorkspaceSnapshotEntry,
    consume?: ((content: Buffer) => Promise<void>) | undefined,
  ): Promise<void> {
    const blobPath = join(this.blobsDir, entry.hash);
    const blobStat = await fs.lstat(blobPath);
    if (blobStat.isSymbolicLink() || !blobStat.isFile()) {
      throw new Error(`Workspace snapshot blob is not a regular file: ${entry.hash}.`);
    }
    if (blobStat.size !== entry.size) {
      throw new Error(`Workspace snapshot blob size does not match: ${entry.path}.`);
    }

    const blob = await fs.open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = await blob.stat();
      if (!openedStat.isFile() || openedStat.size !== entry.size) {
        throw new Error(`Workspace snapshot blob size does not match: ${entry.path}.`);
      }

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await blob.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          break;
        }
        size += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await consume?.(chunk);
      }

      const finalStat = await blob.stat();
      if (size !== entry.size || finalStat.size !== entry.size) {
        throw new Error(`Workspace snapshot blob size does not match: ${entry.path}.`);
      }
      if (hash.digest("hex") !== entry.hash) {
        throw new Error(`Workspace snapshot blob hash does not match: ${entry.path}.`);
      }
    } finally {
      await blob.close();
    }
  }

  private async writeWorkspaceEntry(entry: WorkspaceSnapshotEntry): Promise<void> {
    const absolutePath = join(this.workspaceDir, ...entry.path.split("/"));
    const parentDirectory = dirname(absolutePath);
    await ensureWorkspaceDirectory(this.workspaceDir, parentDirectory);

    const temporaryPath = join(parentDirectory, `.${basename(absolutePath)}.${randomUUID()}.tmp`);
    let temporary: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      temporary = await fs.open(temporaryPath, "wx", 0o600);
      await this.consumeBlob(entry, async (content) => {
        if (temporary === undefined) {
          throw new Error("Workspace snapshot temporary file closed unexpectedly.");
        }
        await writeAll(temporary, content);
      });
      await temporary.sync();
      await temporary.chmod(entry.mode);
      await temporary.sync();
      await temporary.close();
      temporary = undefined;

      if (await pathExists(absolutePath)) {
        const destinationStat = await fs.lstat(absolutePath);
        if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
          throw new Error(`Workspace snapshot destination is not a regular file: ${entry.path}.`);
        }
      }
      await fs.rename(temporaryPath, absolutePath);
      await syncDirectory(parentDirectory);
    } finally {
      await temporary?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private manifestPath(id: string): string {
    return join(this.manifestsDir, `${id}.json`);
  }
}

async function ensureWorkspaceDirectory(root: string, directory: string): Promise<void> {
  const relativeDirectory = relative(root, directory);
  let current = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Workspace snapshot parent is not a regular directory: ${current}.`);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      await fs.mkdir(current, { mode: 0o700 });
      await syncDirectory(dirname(current));
    }
  }
}

async function removeWorkspaceFile(file: SnapshotFile): Promise<void> {
  const stat = await fs.lstat(file.absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Workspace snapshot source is no longer a regular file: ${file.path}.`);
  }
  await fs.rm(file.absolutePath);
  await syncDirectory(dirname(file.absolutePath));
}

async function removeEmptyWorkspaceDirectory(directory: SnapshotFile): Promise<void> {
  try {
    const stat = await fs.lstat(directory.absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Workspace snapshot source is no longer a regular directory: ${directory.path}.`,
      );
    }
    await fs.rmdir(directory.absolutePath);
    await syncDirectory(dirname(directory.absolutePath));
  } catch (error) {
    if (!isDirectoryNotEmptyError(error) && !isNotFoundError(error)) {
      throw error;
    }
  }
}

function parseRestoreJournalEnvelope(value: unknown): RestoreJournalEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace snapshot restore journal must be an object.");
  }
  const journal = value as Record<string, unknown>;
  if (
    (journal.status !== "applying" && journal.status !== "committed") ||
    !("backupManifest" in journal) ||
    typeof journal.targetId !== "string"
  ) {
    throw new Error("Workspace snapshot restore journal is invalid.");
  }
  const keys = Object.keys(journal);
  if (
    keys.length !== 3 ||
    !keys.includes("status") ||
    !keys.includes("targetId") ||
    !keys.includes("backupManifest")
  ) {
    throw new Error("Workspace snapshot restore journal is invalid.");
  }
  return {
    backupManifest: journal.backupManifest,
    status: journal.status,
    targetId: requireSnapshotId(journal.targetId),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workspace snapshot storage is not a regular directory: ${path}.`);
  }
  await fs.chmod(path, 0o700);
}

async function writeAtomicFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    file = await fs.open(temporaryPath, "wx", 0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await fs.rename(temporaryPath, path);
    await fs.chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await file?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeAll(file: Awaited<ReturnType<typeof fs.open>>, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await file.write(content, offset, content.length - offset);
    offset += bytesWritten;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function requireCaptureInput(input: CaptureWorkspaceSnapshotInput): void {
  if (!input.sessionId) {
    throw new Error("Workspace snapshot Session ID must not be empty.");
  }
  if (!Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 0) {
    throw new Error("Workspace snapshot Session revision must be a non-negative safe integer.");
  }
}

function requireSnapshotId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error("Workspace snapshot ID must be a UUID.");
  }
  return id;
}

function requireLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`Workspace snapshot ${name} limit must be a non-negative safe integer.`);
  }
  return limit;
}

function normalizeExcludedPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[a-zA-Z]:\//u.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Workspace snapshot exclusions must be relative POSIX paths.");
  }
  return path;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return isErrorCode(error, "ENOTEMPTY");
}
