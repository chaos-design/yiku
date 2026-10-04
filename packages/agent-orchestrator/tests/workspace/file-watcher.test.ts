import { describe, expect, it, vi } from "vitest";
import { type WatchDirectory, WorkspaceFileWatcher } from "../../src/workspace/file-watcher.js";

describe("WorkspaceFileWatcher", () => {
  it("debounces matching file changes and suppresses duplicate content", async () => {
    const files = new Map([["/workspace/.env", "first"]]);
    const listeners = new Map<string, (fileName: string | null) => void>();
    const close = vi.fn();
    const onChange = vi.fn();
    const watcher = new WorkspaceFileWatcher({
      debounceMs: 5,
      onChange,
      paths: ["/workspace/.env"],
      read: async (path) => files.get(path) ?? "",
      watchDirectory: fakeWatchDirectory(listeners, close),
    });
    await watcher.start();

    listeners.get("/workspace")?.(".env");
    await sleep(10);
    expect(onChange).not.toHaveBeenCalled();

    files.set("/workspace/.env", "second");
    listeners.get("/workspace")?.(".env");
    listeners.get("/workspace")?.(".env");
    await sleep(10);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "second",
        path: "/workspace/.env",
      }),
    );

    watcher.close();
    watcher.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores unrelated file names and reports read failures", async () => {
    const listeners = new Map<string, (fileName: string | null) => void>();
    const onChange = vi.fn();
    const onError = vi.fn();
    let fail = false;
    const watcher = new WorkspaceFileWatcher({
      debounceMs: 1,
      onChange,
      onError,
      paths: ["/workspace/.env"],
      read: async () => {
        if (fail) {
          throw new Error("read failed");
        }
        return "first";
      },
      watchDirectory: fakeWatchDirectory(listeners, vi.fn()),
    });
    await watcher.start();
    listeners.get("/workspace")?.("other.txt");
    await sleep(5);
    expect(onChange).not.toHaveBeenCalled();

    fail = true;
    listeners.get("/workspace")?.(null);
    await sleep(5);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "read failed" }));
    watcher.close();
  });

  it("rejects relative watch paths", () => {
    expect(
      () =>
        new WorkspaceFileWatcher({
          onChange: () => undefined,
          paths: ["relative.txt"],
        }),
    ).toThrow("absolute");
  });

  it("handles missing files, callback failures, duplicate starts, and closed listeners", async () => {
    const listeners = new Map<string, (fileName: string | null) => void>();
    const onError = vi.fn();
    let missing = true;
    const watcher = new WorkspaceFileWatcher({
      debounceMs: 1,
      onChange: async () => {
        throw new Error("callback failed");
      },
      onError,
      paths: ["/workspace/.env", "/workspace/.env"],
      read: async () => {
        if (missing) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return "created";
      },
      watchDirectory: fakeWatchDirectory(listeners, vi.fn()),
    });

    await watcher.start();
    await watcher.start();
    missing = false;
    listeners.get("/workspace")?.(".env");
    await sleep(5);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "callback failed" }));

    watcher.close();
    listeners.get("/workspace")?.(".env");
    await watcher.start();
    await sleep(5);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores a deleted file during a scheduled change", async () => {
    const listeners = new Map<string, (fileName: string | null) => void>();
    let deleted = false;
    const onError = vi.fn();
    const watcher = new WorkspaceFileWatcher({
      debounceMs: 1,
      onChange: vi.fn(),
      onError,
      paths: ["/workspace/.env"],
      read: async () => {
        if (deleted) {
          throw Object.assign(new Error("deleted"), { code: "ENOENT" });
        }
        return "initial";
      },
      watchDirectory: fakeWatchDirectory(listeners, vi.fn()),
    });
    await watcher.start();
    deleted = true;
    listeners.get("/workspace")?.(".env");
    await sleep(5);

    expect(onError).not.toHaveBeenCalled();
    watcher.close();
  });
});

function fakeWatchDirectory(
  listeners: Map<string, (fileName: string | null) => void>,
  close: () => void,
): WatchDirectory {
  return (path, listener) => {
    listeners.set(path, listener);
    return { close };
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
