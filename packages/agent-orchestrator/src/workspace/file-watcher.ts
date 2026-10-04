import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { sha256 } from "@yiku/hooks";
import { isNotFoundError } from "../filesystem.js";

export interface WorkspaceFileChange {
  readonly content: string;
  readonly hash: string;
  readonly path: string;
}

export interface WorkspaceFileWatcherOptions {
  readonly debounceMs?: number | undefined;
  readonly onChange: (change: WorkspaceFileChange) => Promise<void> | void;
  readonly onError?: ((error: Error) => void) | undefined;
  readonly paths: readonly string[];
  readonly read?: ((path: string) => Promise<string>) | undefined;
  readonly watchDirectory?: WatchDirectory | undefined;
}

export interface DirectoryWatcher {
  close(): void;
}

export type WatchDirectory = (
  path: string,
  listener: (fileName: string | null) => void,
) => DirectoryWatcher;

export class WorkspaceFileWatcher {
  private readonly debounceMs: number;
  private readonly hashes = new Map<string, string>();
  private readonly onChange: WorkspaceFileWatcherOptions["onChange"];
  private readonly onError?: WorkspaceFileWatcherOptions["onError"];
  private readonly paths: readonly string[];
  private readonly read: (path: string) => Promise<string>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchDirectory: WatchDirectory;
  private readonly watchers: DirectoryWatcher[] = [];
  private closed = false;

  public constructor(options: WorkspaceFileWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 50;
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.paths = Object.freeze([...new Set(options.paths)]);
    this.read = options.read ?? ((path) => readFile(path, "utf8"));
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory;

    for (const path of this.paths) {
      if (!isAbsolute(path)) {
        throw new Error("Watched Hook file paths must be absolute.");
      }
    }
  }

  public async start(): Promise<void> {
    if (this.closed || this.watchers.length > 0) {
      return;
    }

    await Promise.all(this.paths.map((path) => this.captureInitialHash(path)));
    const pathsByDirectory = groupPaths(this.paths);

    for (const [directory, paths] of pathsByDirectory) {
      this.watchers.push(
        this.watchDirectory(directory, (fileName) => {
          if (this.closed) {
            return;
          }

          for (const path of paths) {
            if (fileName === null || basename(path) === fileName) {
              this.schedule(path);
            }
          }
        }),
      );
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
  }

  private async captureInitialHash(path: string): Promise<void> {
    try {
      const content = await this.read(path);
      this.hashes.set(path, sha256(content));
    } catch (error) {
      if (!isNotFoundError(error)) {
        this.report(error);
      }
    }
  }

  private schedule(path: string): void {
    const current = this.timers.get(path);
    if (current !== undefined) {
      clearTimeout(current);
    }

    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.process(path);
      }, this.debounceMs),
    );
  }

  private async process(path: string): Promise<void> {
    try {
      const content = await this.read(path);
      const hash = sha256(content);

      if (this.hashes.get(path) === hash) {
        return;
      }

      await this.onChange({
        content,
        hash,
        path,
      });
      this.hashes.set(path, hash);
    } catch (error) {
      if (!isNotFoundError(error)) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function groupPaths(paths: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();

  for (const path of paths) {
    const directory = dirname(path);
    const items = grouped.get(directory) ?? [];
    items.push(path);
    grouped.set(directory, items);
  }

  return grouped;
}

function defaultWatchDirectory(
  path: string,
  listener: (fileName: string | null) => void,
): FSWatcher {
  return watch(path, { persistent: false }, (_eventType, fileName) =>
    listener(fileName?.toString() ?? null),
  );
}
