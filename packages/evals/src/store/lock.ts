import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sha256Text } from "../canonical.js";
import { EvaluationError } from "../errors.js";

export interface FileLockManagerOptions {
  readonly clock?: (() => Date) | undefined;
  readonly host?: string | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  readonly lockDir: string;
  readonly pid?: number | undefined;
  readonly staleAfterMs?: number | undefined;
}

export interface FileLockLease {
  release(): Promise<void>;
}

interface LockRecord {
  readonly createdAt: string;
  readonly host: string;
  readonly pid: number;
  readonly resourceDigest: string;
  readonly token: string;
  readonly version: 1;
}

export class FileLockManager {
  private readonly clock: () => Date;
  private readonly host: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly lockDir: string;
  private readonly pid: number;
  private readonly staleAfterMs: number;

  public constructor(options: FileLockManagerOptions) {
    if (!isAbsolute(options.lockDir)) {
      throw new EvaluationError(
        "EVAL_STORE_UNAVAILABLE",
        "Evaluation lock directory must be absolute.",
      );
    }
    this.clock = options.clock ?? (() => new Date());
    this.host = options.host ?? hostname();
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
    this.lockDir = resolve(options.lockDir);
    this.pid = options.pid ?? process.pid;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.pid) ||
      this.pid <= 0 ||
      !Number.isSafeInteger(this.staleAfterMs) ||
      this.staleAfterMs <= 0
    ) {
      throw new EvaluationError(
        "EVAL_STORE_UNAVAILABLE",
        "Evaluation lock PID and stale timeout must be positive integers.",
      );
    }
  }

  public async initialize(): Promise<void> {
    await mkdir(this.lockDir, { mode: 0o700, recursive: true });
    await chmod(this.lockDir, 0o700);
  }

  public async acquire(resource: string): Promise<FileLockLease> {
    await this.initialize();
    const resourceDigest = sha256Text(resource);
    const filePath = join(this.lockDir, `${resourceDigest}.lock`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: LockRecord = {
        createdAt: this.clock().toISOString(),
        host: this.host,
        pid: this.pid,
        resourceDigest,
        token: randomUUID(),
        version: 1,
      };
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(filePath, "wx", 0o600);
        await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await file.sync();
        await file.close();
        file = undefined;
        return lease(filePath, record.token);
      } catch (error) {
        await file?.close().catch(() => undefined);
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw unavailable(`Could not acquire evaluation lock for ${resource}.`, error);
        }
        if (attempt === 0 && (await this.removeStale(filePath, resourceDigest))) {
          continue;
        }
        throw new EvaluationError(
          "EVAL_STORE_CONFLICT",
          `Evaluation resource is locked: ${resource}.`,
          { cause: error },
        );
      }
    }
    throw new EvaluationError("EVAL_STORE_CONFLICT", `Evaluation resource is locked: ${resource}.`);
  }

  private async removeStale(filePath: string, resourceDigest: string): Promise<boolean> {
    const reclaimPath = `${filePath}.reclaim`;
    let reclaim: Awaited<ReturnType<typeof open>> | undefined;
    try {
      reclaim = await open(reclaimPath, "wx", 0o600);
      await reclaim.writeFile(`${this.pid}\n`, "utf8");
      await reclaim.sync();
      const record = parseLock(await readFile(filePath, "utf8"));
      const ageMs = this.clock().getTime() - Date.parse(record.createdAt);
      if (
        record.resourceDigest !== resourceDigest ||
        record.host !== this.host ||
        !Number.isFinite(ageMs) ||
        ageMs <= this.staleAfterMs ||
        this.isProcessAlive(record.pid)
      ) {
        return false;
      }
      await rm(filePath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return true;
      }
      return false;
    } finally {
      if (reclaim !== undefined) {
        await reclaim.close().catch(() => undefined);
        await rm(reclaimPath, { force: true }).catch(() => undefined);
      }
    }
  }
}

function lease(filePath: string, token: string): FileLockLease {
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        const current = parseLock(await readFile(filePath, "utf8"));
        if (current.token === token) {
          await rm(filePath, { force: true });
        }
      } catch {
        // A missing or replaced lock no longer belongs to this lease.
      }
    },
  };
}

function parseLock(text: string): LockRecord {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lock must be an object.");
  }
  const record = value as Partial<LockRecord>;
  if (
    record.version !== 1 ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    typeof record.host !== "string" ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.resourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.resourceDigest) ||
    typeof record.token !== "string" ||
    !record.token
  ) {
    throw new Error("Lock is malformed.");
  }
  return record as LockRecord;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function unavailable(message: string, cause: unknown): EvaluationError {
  return new EvaluationError("EVAL_STORE_UNAVAILABLE", message, { cause });
}
