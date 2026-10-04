import { describe, expect, it, vi } from "vitest";
import { WorkspaceConfigWatcher } from "../../src/workspace/config-watcher.js";
import type { WatchDirectory } from "../../src/workspace/file-watcher.js";

describe("WorkspaceConfigWatcher", () => {
  it("adds the configured source to file changes", async () => {
    let content = "first";
    let listener: ((fileName: string | null) => void) | undefined;
    const onChange = vi.fn();
    const watchDirectory: WatchDirectory = (_path, nextListener) => {
      listener = nextListener;
      return { close: vi.fn() };
    };
    const watcher = new WorkspaceConfigWatcher({
      debounceMs: 1,
      files: [
        {
          path: "/workspace/.claude/settings.json",
          source: "project_settings",
        },
      ],
      onChange,
      read: async () => content,
      watchDirectory,
    });
    await watcher.start();
    content = "second";
    listener?.("settings.json");
    await sleep(5);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "second",
        source: "project_settings",
      }),
    );
    watcher.close();
  });

  it("supports minimal watcher options and idempotent close", async () => {
    const watchDirectory: WatchDirectory = () => ({ close: vi.fn() });
    const watcher = new WorkspaceConfigWatcher({
      files: [
        {
          path: "/missing/.claude/settings.json",
          source: "project_settings",
        },
      ],
      onChange: vi.fn(),
      watchDirectory,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    watcher.close();
    watcher.close();
  });
});

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
