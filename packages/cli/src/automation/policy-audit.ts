import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 90;

export type PolicyAuditEvent =
  | "answer.auto-recommended"
  | "answer.preconfigured"
  | "permission.allow"
  | "permission.deny";

export interface PolicyAuditRecord {
  readonly capability?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly decision: "allow" | "deny";
  readonly event: PolicyAuditEvent;
  readonly policyDigest?: string | undefined;
  readonly questionKey?: string | undefined;
  readonly reason: string;
  readonly resourceDigest?: string | undefined;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly workspaceId: string;
}

export interface PolicyAuditLogOptions {
  readonly filePath?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly retentionDays?: number | undefined;
}

export interface PolicyAuditWriter {
  append(record: PolicyAuditRecord): Promise<void>;
}

export class PolicyAuditLog implements PolicyAuditWriter {
  public readonly filePath: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private readonly retentionDays: number;

  public constructor(options: PolicyAuditLogOptions = {}) {
    this.filePath = resolve(
      options.filePath ?? join(homedir(), ".yiku", "audit", "cli-policy.ndjson"),
    );
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "Audit maxBytes");
    this.retentionDays = boundedRetention(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    this.now = options.now ?? (() => new Date());
  }

  public append(record: PolicyAuditRecord): Promise<void> {
    const result = this.queue.then(() => this.appendRecord(record));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async appendRecord(record: PolicyAuditRecord): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const directoryInspection = await lstat(directory);
    const currentOwner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      directoryInspection.isSymbolicLink() ||
      !directoryInspection.isDirectory() ||
      (currentOwner !== undefined && directoryInspection.uid !== currentOwner)
    ) {
      throw new Error("Policy audit directory is not owned by the current user.");
    }
    await chmod(directory, 0o700);
    await this.assertSafeDestination();
    await this.rotateIfNeeded(record.timestamp);

    const handle = await open(
      this.filePath,
      constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | constants.O_WRONLY,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        (opened.mode & 0o077) !== 0 ||
        (currentOwner !== undefined && opened.uid !== currentOwner)
      ) {
        throw new Error("Policy audit destination is not a private regular file.");
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(this.filePath, 0o600);
    await this.removeExpiredFiles(directory);
  }

  private async assertSafeDestination(): Promise<void> {
    try {
      const inspection = await lstat(this.filePath);
      if (inspection.isSymbolicLink() || !inspection.isFile()) {
        throw new Error("Policy audit path must be a regular file and not a symbolic link.");
      }
      if ((inspection.mode & 0o077) !== 0) {
        throw new Error("Policy audit file must not be accessible by group or other users.");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  private async rotateIfNeeded(timestamp: string): Promise<void> {
    let inspection: Awaited<ReturnType<typeof stat>>;
    try {
      inspection = await stat(this.filePath);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }

    const currentDate = this.now().toISOString().slice(0, 10);
    const fileDate = inspection.mtime.toISOString().slice(0, 10);
    if (inspection.size < this.maxBytes && currentDate === fileDate) {
      return;
    }

    const extension = extname(this.filePath);
    const stem = basename(this.filePath, extension);
    const suffix = timestamp.replaceAll(/[^0-9]/gu, "");
    await rename(this.filePath, join(dirname(this.filePath), `${stem}.${suffix}${extension}`));
  }

  private async removeExpiredFiles(directory: string): Promise<void> {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1_000;
    const extension = extname(this.filePath);
    const stem = basename(this.filePath, extension);
    const prefix = `${stem}.`;
    const entries = await readdir(directory, { withFileTypes: true });

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(extension),
        )
        .map(async (entry) => {
          const path = join(directory, entry.name);
          if ((await stat(path)).mtimeMs < cutoff) {
            await rm(path, { force: true });
          }
        }),
    );
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boundedRetention(value: number): number {
  if (!Number.isSafeInteger(value) || value < 30 || value > 365) {
    throw new Error("Audit retentionDays must be an integer between 30 and 365.");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
