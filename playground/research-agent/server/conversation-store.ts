import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ResearchThreadSnapshot } from "./types.js";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 16 * 1024 * 1024;

export interface ResearchConversationStore {
  load(): Promise<readonly ResearchThreadSnapshot[]>;
  save(threads: readonly ResearchThreadSnapshot[]): Promise<void>;
}

export class MemoryResearchConversationStore implements ResearchConversationStore {
  private threads: readonly ResearchThreadSnapshot[];

  public constructor(initial: readonly ResearchThreadSnapshot[] = []) {
    this.threads = clone(initial);
  }

  public async load(): Promise<readonly ResearchThreadSnapshot[]> {
    return clone(this.threads);
  }

  public async save(threads: readonly ResearchThreadSnapshot[]): Promise<void> {
    this.threads = clone(threads);
  }
}

export interface FileResearchConversationStoreOptions {
  readonly filePath: string;
}

export class FileResearchConversationStore implements ResearchConversationStore {
  private readonly filePath: string;

  public constructor(options: FileResearchConversationStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new Error("Research conversation store path must be absolute.");
    }
    this.filePath = options.filePath;
  }

  public async load(): Promise<readonly ResearchThreadSnapshot[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Research conversation store exceeds 16 MiB.");
    }
    return parseDocument(JSON.parse(content) as unknown);
  }

  public async save(threads: readonly ResearchThreadSnapshot[]): Promise<void> {
    const content = `${JSON.stringify(
      {
        threads,
        version: STORE_VERSION,
      },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Research conversation store exceeds 16 MiB.");
    }
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function parseDocument(value: unknown): readonly ResearchThreadSnapshot[] {
  if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.threads)) {
    throw new Error("Research conversation store is malformed.");
  }
  for (const thread of value.threads) {
    if (
      !isRecord(thread) ||
      !text(thread.threadId) ||
      !text(thread.title) ||
      !text(thread.createdAt) ||
      !text(thread.updatedAt) ||
      !Array.isArray(thread.messages) ||
      !Array.isArray(thread.turns)
    ) {
      throw new Error("Research conversation store contains a malformed thread.");
    }
  }
  return clone(value.threads as unknown as readonly ResearchThreadSnapshot[]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
