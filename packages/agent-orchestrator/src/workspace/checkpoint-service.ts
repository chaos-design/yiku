import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isNotFoundError, syncDirectory } from "../filesystem.js";
import type { AgentMessageBus } from "../messages/message-bus.js";
import type { AgentMessageEnvelope } from "../messages/types.js";
import type { WorkspaceSnapshotManifest } from "./snapshot-types.js";
import type { CaptureWorkspaceSnapshotInput } from "./workspace-snapshot-store.js";

export interface CheckpointHistoryEntry {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export interface CheckpointRecord {
  readonly createdAt: string;
  readonly eventHead?: string | undefined;
  readonly fileCount?: number | undefined;
  readonly historyEntries: readonly CheckpointHistoryEntry[];
  readonly id: string;
  readonly prompt: string;
  readonly sessionRevision: number;
  readonly totalBytes?: number | undefined;
}

export interface CreateCheckpointInput {
  readonly eventHead?: string | undefined;
  readonly historyEntries: readonly CheckpointHistoryEntry[];
  readonly prompt: string;
  readonly sessionRevision: number;
}

export interface CheckpointSnapshotStore {
  capture(input: CaptureWorkspaceSnapshotInput): Promise<WorkspaceSnapshotManifest>;
  load(id: string): Promise<WorkspaceSnapshotManifest>;
  restore(id: string): Promise<void>;
}

export interface CheckpointServiceOptions {
  readonly clock?: (() => Date) | undefined;
  readonly indexFilePath: string;
  readonly messageBus?: AgentMessageBus | undefined;
  readonly sessionId: string;
  readonly snapshotStore: CheckpointSnapshotStore;
}

export class CheckpointService {
  private readonly clock: () => Date;
  private currentTurnCheckpoint: CheckpointRecord | undefined;
  private currentTurnInput: CreateCheckpointInput | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: CheckpointServiceOptions) {
    if (!isAbsolute(options.indexFilePath)) {
      throw new Error("Checkpoint index file path must be absolute.");
    }
    if (!options.sessionId.trim()) {
      throw new Error("Checkpoint Session ID must not be empty.");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  public beforeTurn(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    const turnInput = snapshotInput(input);
    return this.enqueue(async () => {
      this.currentTurnInput = turnInput;
      this.currentTurnCheckpoint = undefined;
      return this.create(turnInput);
    });
  }

  public beforeTool(): Promise<CheckpointRecord> {
    return this.enqueue(async () => {
      if (this.currentTurnCheckpoint !== undefined) {
        return this.currentTurnCheckpoint;
      }
      if (this.currentTurnInput === undefined) {
        throw new Error("Cannot create a tool checkpoint before a Session turn has started.");
      }
      return this.create(this.currentTurnInput);
    });
  }

  public list(): Promise<readonly CheckpointRecord[]> {
    return this.enqueue(async () => Object.freeze(await this.readIndex()));
  }

  public restore(id: string): Promise<CheckpointRecord> {
    return this.enqueue(async () => {
      const checkpoint = (await this.readIndex()).find((candidate) => candidate.id === id);
      if (checkpoint === undefined) {
        throw new Error(`Checkpoint is not indexed for this Session: ${id}.`);
      }

      const manifest = await this.options.snapshotStore.load(id);
      if (manifest.sessionId !== this.options.sessionId) {
        throw new Error(`Checkpoint belongs to another Session: ${id}.`);
      }
      await this.options.snapshotStore.restore(id);
      await this.publish("restored", id, this.clock().toISOString());
      return checkpoint;
    });
  }

  private async create(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    const manifest = await this.options.snapshotStore.capture({
      ...(input.eventHead === undefined ? {} : { eventHead: input.eventHead }),
      sessionId: this.options.sessionId,
      sessionRevision: input.sessionRevision,
    });
    const checkpoint = freezeRecord({
      createdAt: this.clock().toISOString(),
      ...(input.eventHead === undefined ? {} : { eventHead: input.eventHead }),
      fileCount: manifest.entries.length,
      historyEntries: input.historyEntries,
      id: manifest.id,
      prompt: input.prompt,
      sessionRevision: input.sessionRevision,
      totalBytes: manifest.entries.reduce((total, entry) => total + entry.size, 0),
    });
    const checkpoints = [...(await this.readIndex()), checkpoint].toSorted(compareCheckpoints);
    await writeAtomicFile(this.options.indexFilePath, `${JSON.stringify(checkpoints, null, 2)}\n`);
    this.currentTurnCheckpoint = checkpoint;
    await this.publish("created", checkpoint.id, checkpoint.createdAt);
    return checkpoint;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async publish(
    action: "created" | "restored",
    checkpointId: string,
    occurredAt: string,
  ): Promise<void> {
    if (this.options.messageBus === undefined) {
      return;
    }
    const message: AgentMessageEnvelope = {
      agentId: this.options.sessionId,
      eventId: randomUUID(),
      occurredAt,
      payload: {
        action,
        checkpointId,
        kind: "checkpoint",
      },
      sessionId: this.options.sessionId,
    };
    await this.options.messageBus.publish(message);
  }

  private async readIndex(): Promise<CheckpointRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.options.indexFilePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const value: unknown = JSON.parse(content);
    if (!Array.isArray(value)) {
      throw new Error("Checkpoint index must be a JSON array.");
    }
    return value.map(parseCheckpointRecord).toSorted(compareCheckpoints);
  }
}

function snapshotInput(input: CreateCheckpointInput): CreateCheckpointInput {
  if (!Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 0) {
    throw new Error("Checkpoint Session revision must be a non-negative safe integer.");
  }
  return Object.freeze({
    ...(input.eventHead === undefined ? {} : { eventHead: input.eventHead }),
    historyEntries: Object.freeze(input.historyEntries.map(snapshotHistoryEntry)),
    prompt: input.prompt,
    sessionRevision: input.sessionRevision,
  });
}

function snapshotHistoryEntry(entry: CheckpointHistoryEntry): CheckpointHistoryEntry {
  return Object.freeze({
    content: entry.content,
    role: entry.role,
  });
}

function parseCheckpointRecord(value: unknown): CheckpointRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Checkpoint index entry must be an object.");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.createdAt !== "string" ||
    typeof entry.prompt !== "string" ||
    !Number.isSafeInteger(entry.sessionRevision) ||
    (entry.eventHead !== undefined && typeof entry.eventHead !== "string") ||
    (entry.fileCount !== undefined &&
      (!Number.isSafeInteger(entry.fileCount) || Number(entry.fileCount) < 0)) ||
    (entry.totalBytes !== undefined &&
      (!Number.isSafeInteger(entry.totalBytes) || Number(entry.totalBytes) < 0)) ||
    !Array.isArray(entry.historyEntries)
  ) {
    throw new Error("Checkpoint index entry is invalid.");
  }
  const createdAt = new Date(entry.createdAt);
  if (Number.isNaN(createdAt.valueOf())) {
    throw new Error("Checkpoint index entry creation time is invalid.");
  }

  return freezeRecord({
    createdAt: entry.createdAt,
    ...(entry.eventHead === undefined ? {} : { eventHead: entry.eventHead }),
    ...(entry.fileCount === undefined ? {} : { fileCount: entry.fileCount as number }),
    historyEntries: entry.historyEntries.map(parseHistoryEntry),
    id: entry.id,
    prompt: entry.prompt,
    sessionRevision: entry.sessionRevision as number,
    ...(entry.totalBytes === undefined ? {} : { totalBytes: entry.totalBytes as number }),
  });
}

function parseHistoryEntry(value: unknown): CheckpointHistoryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Checkpoint history entry must be an object.");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.content !== "string" ||
    (entry.role !== "assistant" && entry.role !== "system" && entry.role !== "user")
  ) {
    throw new Error("Checkpoint history entry is invalid.");
  }
  return snapshotHistoryEntry({
    content: entry.content,
    role: entry.role,
  });
}

function freezeRecord(record: CheckpointRecord): CheckpointRecord {
  return Object.freeze({
    ...record,
    historyEntries: Object.freeze(record.historyEntries.map(snapshotHistoryEntry)),
  });
}

function compareCheckpoints(left: CheckpointRecord, right: CheckpointRecord): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

async function writeAtomicFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
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
