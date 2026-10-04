import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StudioEvent, StudioRunSummary } from "../types.js";
import { invalidRequest } from "./errors.js";
import type { StoredStudioRun, StudioStore } from "./types.js";

export interface FileStudioStoreOptions {
  readonly decodeRun?:
    | ((value: unknown, events: readonly StudioEvent[]) => StudioRunSummary)
    | undefined;
  readonly encodeRun?:
    | ((run: StudioRunSummary, previous: unknown | undefined) => unknown)
    | undefined;
  readonly eventsFileName?: string | undefined;
  readonly rootDir: string;
  readonly runFileName?: string | undefined;
  readonly storageKey?: ((runId: string) => string) | undefined;
}

export class FileStudioStore implements StudioStore {
  private readonly decodeRun: (value: unknown, events: readonly StudioEvent[]) => StudioRunSummary;
  private readonly directories = new Map<string, string>();
  private readonly encodeRun: (run: StudioRunSummary, previous: unknown | undefined) => unknown;
  private readonly eventsFileName: string;
  private readonly previousRuns = new Map<string, unknown>();
  private readonly rootDir: string;
  private readonly runFileName: string;
  private readonly storageKey: (runId: string) => string;

  public constructor(options: FileStudioStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.eventsFileName = requireFileName(options.eventsFileName ?? "events.jsonl");
    this.runFileName = requireFileName(options.runFileName ?? "run.json");
    this.storageKey = options.storageKey ?? defaultStorageKey;
    this.decodeRun = options.decodeRun ?? decodeRun;
    this.encodeRun = options.encodeRun ?? ((run) => run);
  }

  public async initialize(): Promise<readonly StoredStudioRun[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = (await readdir(this.rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const runs: StoredStudioRun[] = [];

    for (const entry of entries) {
      try {
        const directory = join(this.rootDir, entry.name);
        const events = await readEvents(join(directory, this.eventsFileName));
        const raw = JSON.parse(
          await readFile(join(directory, this.runFileName), "utf8"),
        ) as unknown;
        const run = this.decodeRun(raw, events);
        if (this.directories.has(run.runId)) {
          continue;
        }
        this.directories.set(run.runId, directory);
        this.previousRuns.set(run.runId, raw);
        runs.push({ events, run });
      } catch {
        // Corrupt directories remain untouched for manual inspection.
      }
    }
    return runs;
  }

  public async appendEvent(event: StudioEvent): Promise<void> {
    const directory = await this.requireRunDirectory(event.runId);
    await appendFile(join(directory, this.eventsFileName), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  public async writeRun(run: StudioRunSummary): Promise<void> {
    const directory = await this.requireRunDirectory(run.runId);
    const encoded = this.encodeRun(run, this.previousRuns.get(run.runId));
    await writeFile(join(directory, this.runFileName), `${JSON.stringify(encoded, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.previousRuns.set(run.runId, encoded);
  }

  public async close(): Promise<void> {
    // File writes complete before their promises resolve, so no open handle remains.
  }

  private async requireRunDirectory(runId: string): Promise<string> {
    const known = this.directories.get(runId);
    if (known !== undefined) {
      return known;
    }
    const key = this.storageKey(runId);
    if (!/^[a-zA-Z0-9._-]+$/u.test(key) || key === "." || key === "..") {
      throw invalidRequest("Studio storage key contains unsupported characters.");
    }
    const directory = join(this.rootDir, key);
    await mkdir(directory, { recursive: true });
    this.directories.set(runId, directory);
    return directory;
  }
}

async function readEvents(filePath: string): Promise<readonly StudioEvent[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return contents
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => parseEvent(JSON.parse(line) as unknown));
}

function parseEvent(value: unknown): StudioEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Stored Studio event must be an object.");
  }
  const event = value as Partial<StudioEvent>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.runId !== "string" ||
    typeof event.occurredAt !== "string" ||
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence ?? 0) <= 0
  ) {
    throw invalidRequest("Stored Studio event is malformed.");
  }
  return value as StudioEvent;
}

function decodeRun(value: unknown, events: readonly StudioEvent[]): StudioRunSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Stored Studio run must be an object.");
  }
  const run = value as Partial<StudioRunSummary>;
  if (
    typeof run.createdAt !== "string" ||
    typeof run.runId !== "string" ||
    typeof run.status !== "string" ||
    typeof run.title !== "string" ||
    typeof run.updatedAt !== "string"
  ) {
    throw invalidRequest("Stored Studio run is malformed.");
  }
  return {
    ...run,
    eventCount: events.length,
  } as StudioRunSummary;
}

function defaultStorageKey(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

function requireFileName(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw invalidRequest("Studio file name contains unsupported characters.");
  }
  return value;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
