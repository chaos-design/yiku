import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRegistry } from "../../src/web/web-registry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("WebRegistry", () => {
  it("registers, discovers, and unregisters a healthy loopback server", async () => {
    const homeDir = await createTempDir();
    const request = vi.fn(async () => Response.json({ status: "ok" }));
    const registry = new WebRegistry({
      homeDir,
      pid: 123,
      processExists: () => true,
      request,
    });

    await registry.register({
      endpoint: "http://127.0.0.1:3333/",
      workspaceDir: "/workspace",
    });

    await expect(registry.discover()).resolves.toBe("http://127.0.0.1:3333");
    await expect(registry.find()).resolves.toMatchObject({
      endpoint: "http://127.0.0.1:3333",
      pid: 123,
    });
    await expect(registry.current()).resolves.toMatchObject({
      pid: 123,
    });
    expect(registry.logFilePath()).toBe(join(homeDir, ".yiku", "web.log"));
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:3333/api/health",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(await readFile(registry.filePath(), "utf8"))).toMatchObject({
      endpoint: "http://127.0.0.1:3333",
      pid: 123,
      workspaceDir: "/workspace",
    });

    await registry.unregister();
    await expect(access(registry.filePath())).rejects.toThrow();
  });

  it("ignores stale registrations and removes their record", async () => {
    const homeDir = await createTempDir();
    const owner = new WebRegistry({
      homeDir,
      pid: 123,
      processExists: () => true,
    });
    await owner.register({
      endpoint: "http://localhost:4317",
      workspaceDir: "/workspace",
    });
    const reader = new WebRegistry({
      homeDir,
      pid: 456,
      processExists: () => false,
    });

    await expect(reader.discover()).resolves.toBeUndefined();
    await expect(access(reader.filePath())).rejects.toThrow();
  });

  it("does not let an old process remove a newer registration", async () => {
    const homeDir = await createTempDir();
    const first = new WebRegistry({ homeDir, pid: 123 });
    const second = new WebRegistry({ homeDir, pid: 456 });
    await first.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/first",
    });
    await second.register({
      endpoint: "http://127.0.0.1:4444",
      workspaceDir: "/second",
    });

    await first.unregister();

    expect(JSON.parse(await readFile(second.filePath(), "utf8"))).toMatchObject({
      endpoint: "http://127.0.0.1:4444",
      pid: 456,
    });
  });

  it("rejects non-loopback registration endpoints", async () => {
    const registry = new WebRegistry({
      homeDir: await createTempDir(),
    });

    await expect(
      registry.register({
        endpoint: "https://example.com",
        workspaceDir: "/workspace",
      }),
    ).rejects.toThrow("loopback HTTP URL");
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-web-registry-"));
  directories.push(directory);
  return directory;
}
