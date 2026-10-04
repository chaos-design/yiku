import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HookRedactor, type JsonValue } from "@yiku/hooks";
import { isAlreadyExistsError, isNotFoundError } from "../filesystem.js";
import { parseSessionState, type SessionBudgetState, type SessionState } from "./session-state.js";

const DEFAULT_MAX_STATE_BYTES = 1_048_576;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const RESUMABLE_STATUSES = new Set<SessionState["status"]>(["active", "needs-review", "paused"]);

export type AtomicWriteStep =
  | "chmod"
  | "directory-sync"
  | "file-sync"
  | "mkdir"
  | "rename"
  | "write";

export interface SessionStoreOptions {
  readonly heartbeatIntervalMs?: number | undefined;
  readonly hostname?: string | undefined;
  readonly maxStateBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onAtomicWriteStep?: ((step: AtomicWriteStep) => void) | undefined;
  readonly pid?: number | undefined;
  readonly processExists?: ((pid: number) => boolean | Promise<boolean>) | undefined;
  readonly sessionsDir: string;
}

export interface AcquireSessionLeaseOptions {
  readonly force?: boolean | undefined;
}

export interface CloneSessionOptions {
  readonly sessionId: string;
  readonly title?: string | undefined;
}

interface SessionLease {
  readonly heartbeatAt: string;
  readonly hostname: string;
  readonly pid: number;
  readonly sessionId: string;
}

interface HeldLease {
  readonly timer?: ReturnType<typeof setInterval> | undefined;
}

export class SessionStore {
  private readonly heartbeatIntervalMs: number;
  private readonly heldLeases = new Map<string, HeldLease>();
  private readonly hostname: string;
  private readonly maxStateBytes: number;
  private readonly now: () => Date;
  private readonly onAtomicWriteStep?: ((step: AtomicWriteStep) => void) | undefined;
  private readonly pid: number;
  private readonly processExists: (pid: number) => boolean | Promise<boolean>;
  private readonly redactor = new HookRedactor();
  private readonly sessionsDir: string;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: SessionStoreOptions) {
    if (!isAbsolute(options.sessionsDir)) {
      throw new Error("Session Store directory must be absolute.");
    }
    this.sessionsDir = resolve(options.sessionsDir);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.hostname = options.hostname ?? systemHostname();
    this.maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
    this.now = options.now ?? (() => new Date());
    this.onAtomicWriteStep = options.onAtomicWriteStep;
    this.pid = options.pid ?? process.pid;
    this.processExists = options.processExists ?? defaultProcessExists;
  }

  public stateFilePath(sessionId: string): string {
    return this.resolveArtifactPath(`${requireSessionId(sessionId)}.state.json`);
  }

  public leaseFilePath(sessionId: string): string {
    return this.resolveArtifactPath(`${requireSessionId(sessionId)}.lease`);
  }

  public create(state: SessionState): Promise<SessionState> {
    return this.enqueue(async () => {
      this.assertOpen();
      const normalized = this.redactState(state);
      const path = this.stateFilePath(normalized.sessionId);
      if (await pathExists(path)) {
        throw new Error(`Session state already exists: ${normalized.sessionId}.`);
      }
      await this.persist(path, normalized);
      return normalized;
    });
  }

  public async rename(sessionId: string, title: string): Promise<SessionState> {
    const normalizedTitle = requireSessionTitle(title);
    const current = await this.load(sessionId);
    return this.update(sessionId, current.revision, (state) =>
      parseSessionState({
        ...state,
        title: normalizedTitle,
      }),
    );
  }

  public async clone(sourceId: string, options: CloneSessionOptions): Promise<SessionState> {
    const sessionId = requireSessionId(options.sessionId);
    const title = options.title === undefined ? undefined : requireSessionTitle(options.title);
    const source = await this.load(sourceId);
    const {
      lastCompletedOperation: _lastCompletedOperation,
      pendingInput: _pendingInput,
      ...durable
    } = source;
    const timestamp = this.now().toISOString();

    return this.create(
      parseSessionState({
        ...durable,
        budget: startNewEpoch(source.budget),
        createdAt: timestamp,
        eventLogPath: `${sessionId}.events.jsonl`,
        inFlightOperations: [],
        revision: 1,
        sessionId,
        status: "active",
        ...(title === undefined ? {} : { title }),
        updatedAt: timestamp,
      }),
    );
  }

  public startEpoch(sessionId: string): Promise<SessionState> {
    return this.load(sessionId).then((current) =>
      this.update(sessionId, current.revision, (state) => {
        if (state.inFlightOperations.length > 0) {
          throw new Error("Cannot start a new Session epoch with in-flight operations.");
        }
        if (state.status === "needs-review" || state.pendingInput !== undefined) {
          throw new Error("Cannot start a new Session epoch with pending review or input.");
        }

        return parseSessionState({
          ...state,
          budget: startNewEpoch(state.budget),
          status: "active",
        });
      }),
    );
  }

  public remove(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      const normalizedId = requireSessionId(sessionId);
      if (this.heldLeases.has(normalizedId)) {
        throw new Error(`Cannot remove Session with a held Session lease: ${normalizedId}.`);
      }

      const state = await this.load(normalizedId);
      const paths = new Set([
        this.stateFilePath(normalizedId),
        this.resolveEventLogPath(state.eventLogPath),
        this.resolveArtifactPath(`${normalizedId}.transcript.jsonl`),
        this.resolveArtifactPath(`${normalizedId}.jsonl`),
        this.leaseFilePath(normalizedId),
      ]);
      await Promise.all([...paths].map((path) => rm(path, { force: true })));
    });
  }

  public async load(sessionId: string): Promise<SessionState> {
    this.assertOpen();
    return parseSessionState(JSON.parse(await readFile(this.stateFilePath(sessionId), "utf8")));
  }

  public update(
    sessionId: string,
    expectedRevision: number,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = await this.load(sessionId);
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Session revision conflict: expected ${expectedRevision}, received ${current.revision}.`,
        );
      }

      return this.persistUpdate(sessionId, current, update);
    });
  }

  public updateCurrent(
    sessionId: string,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = await this.load(sessionId);
      return this.persistUpdate(sessionId, current, update);
    });
  }

  public async list(workspaceDir: string): Promise<readonly SessionState[]> {
    return Object.freeze(await this.listWorkspaceStates(workspaceDir));
  }

  public async listResumable(workspaceDir: string): Promise<readonly SessionState[]> {
    const states = await this.listWorkspaceStates(workspaceDir);
    return Object.freeze(states.filter((state) => RESUMABLE_STATUSES.has(state.status)));
  }

  private async listWorkspaceStates(workspaceDir: string): Promise<SessionState[]> {
    this.assertOpen();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const states: SessionState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".state.json")) {
        continue;
      }
      const state = parseSessionState(
        JSON.parse(await readFile(this.resolveArtifactPath(entry.name), "utf8")),
      );
      if (resolve(state.workspaceDir) !== resolve(workspaceDir)) {
        continue;
      }
      states.push(state);
    }

    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async persistUpdate(
    sessionId: string,
    current: SessionState,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState> {
    const proposed = update(current);
    const normalized = this.redactState({
      ...proposed,
      createdAt: current.createdAt,
      revision: current.revision + 1,
      schemaVersion: current.schemaVersion,
      sessionId: current.sessionId,
      updatedAt: this.now().toISOString(),
      workspaceDir: current.workspaceDir,
    });
    await this.persist(this.stateFilePath(sessionId), normalized);
    return normalized;
  }

  public async acquireLease(
    sessionId: string,
    options: AcquireSessionLeaseOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const normalizedId = requireSessionId(sessionId);
    if (this.heldLeases.has(normalizedId)) {
      return;
    }
    await mkdir(this.sessionsDir, { mode: 0o700, recursive: true });

    try {
      await this.writeLeaseExclusive(normalizedId);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      const current = await this.readLease(normalizedId);
      if (current.hostname !== this.hostname) {
        if (options.force !== true) {
          throw new Error(`Cannot acquire remote Session lease: ${normalizedId}.`);
        }
      } else if (current.pid === this.pid || (await this.processExists(current.pid))) {
        throw new Error(`Cannot acquire active Session lease: ${normalizedId}.`);
      }

      await rm(this.leaseFilePath(normalizedId), { force: true });
      await this.writeLeaseExclusive(normalizedId);
    }

    this.heldLeases.set(normalizedId, {
      timer: this.startHeartbeat(normalizedId),
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue.catch(() => undefined);
    const errors: unknown[] = [];

    for (const [sessionId, lease] of this.heldLeases) {
      if (lease.timer !== undefined) {
        clearInterval(lease.timer);
      }
      try {
        await rm(this.leaseFilePath(sessionId), { force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    this.heldLeases.clear();

    if (errors.length > 0) {
      throw new AggregateError(errors, "Unable to release Session leases.");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(path: string, state: SessionState): Promise<void> {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxStateBytes) {
      throw new Error(`Session state exceeds ${this.maxStateBytes} bytes.`);
    }

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      await mkdir(this.sessionsDir, { mode: 0o700, recursive: true });
      this.onAtomicWriteStep?.("mkdir");
      fileHandle = await open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(content, "utf8");
      this.onAtomicWriteStep?.("write");
      await fileHandle.sync();
      this.onAtomicWriteStep?.("file-sync");
      await fileHandle.close();
      fileHandle = undefined;
      await rename(temporaryPath, path);
      this.onAtomicWriteStep?.("rename");
      directoryHandle = await open(this.sessionsDir, "r");
      await directoryHandle.sync();
      this.onAtomicWriteStep?.("directory-sync");
      await directoryHandle.close();
      directoryHandle = undefined;
      await chmod(path, 0o600);
      this.onAtomicWriteStep?.("chmod");
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private resolveArtifactPath(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath)) {
      throw new Error("Session artifact path must be relative to the Sessions directory.");
    }

    const resolvedPath = resolve(this.sessionsDir, relativePath);
    const pathFromSessionsDirectory = relative(this.sessionsDir, resolvedPath);
    if (
      !pathFromSessionsDirectory ||
      pathFromSessionsDirectory === ".." ||
      pathFromSessionsDirectory.startsWith(`..${sep}`) ||
      isAbsolute(pathFromSessionsDirectory)
    ) {
      throw new Error("Session artifact path must stay within the Sessions directory.");
    }
    return resolvedPath;
  }

  private resolveEventLogPath(eventLogPath: string): string {
    try {
      return this.resolveArtifactPath(eventLogPath.trim());
    } catch (error) {
      throw new Error("Session event log path must stay within the Sessions directory.", {
        cause: error,
      });
    }
  }

  private redactState(state: SessionState): SessionState {
    const value = JSON.parse(JSON.stringify(state)) as JsonValue;
    return parseSessionState(this.redactor.redactJson(value));
  }

  private async writeLeaseExclusive(sessionId: string): Promise<void> {
    const handle = await open(this.leaseFilePath(sessionId), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.createLease(sessionId))}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readLease(sessionId: string): Promise<SessionLease> {
    const value: unknown = JSON.parse(await readFile(this.leaseFilePath(sessionId), "utf8"));
    if (
      !isRecord(value) ||
      typeof value.heartbeatAt !== "string" ||
      typeof value.hostname !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.sessionId !== "string"
    ) {
      throw new Error(`Session lease is invalid: ${sessionId}.`);
    }
    return value as unknown as SessionLease;
  }

  private createLease(sessionId: string): SessionLease {
    return {
      heartbeatAt: this.now().toISOString(),
      hostname: this.hostname,
      pid: this.pid,
      sessionId,
    };
  }

  private startHeartbeat(sessionId: string): ReturnType<typeof setInterval> | undefined {
    if (this.heartbeatIntervalMs <= 0) {
      return undefined;
    }
    const timer = setInterval(() => {
      void writeFile(
        this.leaseFilePath(sessionId),
        `${JSON.stringify(this.createLease(sessionId))}\n`,
        { mode: 0o600 },
      ).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref();
    return timer;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Session Store is closed.");
    }
  }
}

function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized.length > 256 || !/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error("Session ID contains unsupported characters.");
  }
  return normalized;
}

function requireSessionTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length < 1 || normalized.length > 200) {
    throw new Error("Session title must be between 1 and 200 characters.");
  }
  return normalized;
}

function startNewEpoch(budget: SessionBudgetState): SessionBudgetState {
  return {
    ...budget,
    epoch: budget.epoch + 1,
    noProgressStages: 0,
    stage: 0,
    toolCalls: 0,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
