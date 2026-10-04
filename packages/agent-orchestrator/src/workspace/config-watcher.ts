import type { ConfigChangeHookEvent } from "@yiku/hooks";
import {
  type WatchDirectory,
  type WorkspaceFileChange,
  WorkspaceFileWatcher,
} from "./file-watcher.js";

export interface WorkspaceConfigFile {
  readonly path: string;
  readonly source: ConfigChangeHookEvent["source"];
}

export interface WorkspaceConfigChange extends WorkspaceFileChange {
  readonly source: ConfigChangeHookEvent["source"];
}

export interface WorkspaceConfigWatcherOptions {
  readonly debounceMs?: number | undefined;
  readonly files: readonly WorkspaceConfigFile[];
  readonly onChange: (change: WorkspaceConfigChange) => Promise<void> | void;
  readonly onError?: ((error: Error) => void) | undefined;
  readonly read?: ((path: string) => Promise<string>) | undefined;
  readonly watchDirectory?: WatchDirectory | undefined;
}

export class WorkspaceConfigWatcher {
  private readonly fileWatcher: WorkspaceFileWatcher;

  public constructor(options: WorkspaceConfigWatcherOptions) {
    const sources = new Map(options.files.map((file) => [file.path, file.source]));

    this.fileWatcher = new WorkspaceFileWatcher({
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      onChange: async (change) => {
        const source = sources.get(change.path);
        if (source === undefined) {
          return;
        }
        await options.onChange({
          ...change,
          source,
        });
      },
      paths: options.files.map((file) => file.path),
      ...(options.read !== undefined ? { read: options.read } : {}),
      ...(options.watchDirectory !== undefined ? { watchDirectory: options.watchDirectory } : {}),
    });
  }

  public start(): Promise<void> {
    return this.fileWatcher.start();
  }

  public close(): void {
    this.fileWatcher.close();
  }
}
