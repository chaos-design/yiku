import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRegistry } from "../../src/web/web-registry.js";
import { runWebCommand } from "../../src/web/web-runtime.js";

const { apiServerMock, spawnMock } = vi.hoisted(() => ({
  apiServerMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("@yiku/agent-observatory/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@yiku/agent-observatory/server")>();
  return {
    ...original,
    ApiServer: class {
      private readonly server;

      public constructor(options: unknown) {
        this.server = apiServerMock(options);
      }

      public close(): Promise<void> {
        return this.server.close();
      }

      public start(): Promise<{ readonly host: string; readonly port: number }> {
        return this.server.start();
      }
    },
  };
});

const directories: string[] = [];

afterEach(async () => {
  apiServerMock.mockReset();
  spawnMock.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("runWebCommand", () => {
  it("runs the Web server and conversation in one foreground lifecycle", async () => {
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const openBrowser = vi.fn(async () => undefined);
    const runConversation = vi.fn(async () => 7);
    const createServer = vi.fn(() => ({
      close,
      start: vi.fn(async () => ({ host: "127.0.0.1", port: 3333 })),
    }));

    await expect(
      runWebCommand({
        createServer,
        cwd: "/workspace",
        openBrowser,
        port: 3333,
        runConversation,
        stdout: output.stream,
      }),
    ).resolves.toBe(7);

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3333,
        workspaceDir: "/workspace",
      }),
    );
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3333");
    expect(runConversation).toHaveBeenCalledWith("http://127.0.0.1:3333");
    expect(output.read()).toContain("Yiku Web ready: http://127.0.0.1:3333");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not reopen an already connected Observatory browser page", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const runConversation = vi.fn(async () => 0);
    const sleep = vi.fn(async () => undefined);
    const hasBrowserClient = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    await expect(
      runWebCommand({
        browserDetectionTimeoutMs: 100,
        createServer: () => ({
          close: async () => undefined,
          hasBrowserClient,
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        openBrowser,
        port: 3333,
        runConversation,
        sleep,
      }),
    ).resolves.toBe(0);

    expect(sleep).toHaveBeenCalledWith(50);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(runConversation).toHaveBeenCalledWith("http://127.0.0.1:3333");
  });

  it("increments the port only while addresses are in use", async () => {
    const closedPorts: number[] = [];
    const attemptedPorts: number[] = [];
    const createServer = vi.fn(({ port = 0 }: { readonly port?: number }) => {
      attemptedPorts.push(port);
      return {
        close: vi.fn(async () => {
          closedPorts.push(port);
        }),
        start: vi.fn(async () => {
          if (port < 3335) {
            throw addressInUse();
          }
          return { host: "127.0.0.1", port };
        }),
      };
    });
    const runConversation = vi.fn(async () => 0);

    await expect(
      runWebCommand({
        createServer,
        openBrowser: async () => undefined,
        port: 3333,
        runConversation,
      }),
    ).resolves.toBe(0);

    expect(attemptedPorts).toEqual([3333, 3334, 3335]);
    expect(closedPorts).toEqual([3333, 3334, 3335]);
    expect(runConversation).toHaveBeenCalledWith("http://127.0.0.1:3335");
  });

  it("creates the default API server when no server factory is injected", async () => {
    const close = vi.fn(async () => undefined);
    apiServerMock.mockReturnValue({
      close,
      start: async () => ({ host: "127.0.0.1", port: 3333 }),
    });

    await expect(
      runWebCommand({
        cwd: "/workspace",
        openBrowser: async () => undefined,
        port: 3333,
        runConversation: async () => 0,
        stdout: createOutput().stream,
      }),
    ).resolves.toBe(0);

    expect(apiServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3333,
        workspaceDir: "/workspace",
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails after the final port is already in use", async () => {
    const close = vi.fn(async () => undefined);
    const runConversation = vi.fn(async () => 0);

    await expect(
      runWebCommand({
        createServer: () => ({
          close,
          start: async () => {
            throw addressInUse();
          },
        }),
        port: 65_535,
        runConversation,
      }),
    ).rejects.toThrow("from 65535 to 65535");

    expect(close).toHaveBeenCalledOnce();
    expect(runConversation).not.toHaveBeenCalled();
  });

  it("does not retry non-port startup failures", async () => {
    const createServer = vi.fn(() => ({
      close: vi.fn(async () => undefined),
      start: async () => {
        throw new Error("static assets are missing");
      },
    }));

    await expect(
      runWebCommand({
        createServer,
        port: 3333,
        runConversation: async () => 0,
      }),
    ).rejects.toThrow("static assets are missing");
    expect(createServer).toHaveBeenCalledOnce();
  });

  it("continues the conversation when the browser cannot be opened", async () => {
    const stderr = createOutput();
    const runConversation = vi.fn(async () => 0);

    await expect(
      runWebCommand({
        createServer: () => ({
          close: async () => undefined,
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        openBrowser: async () => {
          throw new Error("browser unavailable");
        },
        port: 3333,
        runConversation,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(0);

    expect(runConversation).toHaveBeenCalledOnce();
    expect(stderr.read()).toContain("Open http://127.0.0.1:3333 manually");
  });

  it("preserves conversation failures when closing also fails", async () => {
    const stderr = createOutput();

    await expect(
      runWebCommand({
        createServer: () => ({
          close: async () => {
            throw new Error("close failed");
          },
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        openBrowser: async () => undefined,
        port: 3333,
        runConversation: async () => {
          throw new Error("conversation failed");
        },
        stderr: stderr.stream,
      }),
    ).rejects.toThrow("conversation failed");

    expect(stderr.read()).toContain("Could not close Yiku Web cleanly");
  });

  it("preserves a conversation failure when closing succeeds", async () => {
    await expect(
      runWebCommand({
        createServer: () => ({
          close: async () => undefined,
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        openBrowser: async () => undefined,
        port: 3333,
        runConversation: async () => {
          throw new Error("conversation failed");
        },
      }),
    ).rejects.toThrow("conversation failed");
  });

  it("reports a close failure after a successful conversation", async () => {
    await expect(
      runWebCommand({
        createServer: () => ({
          close: async () => {
            throw new Error("close failed");
          },
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        openBrowser: async () => undefined,
        port: 3333,
        runConversation: async () => 0,
      }),
    ).rejects.toThrow("close failed");
  });

  it.each([
    ["darwin", "open", ["http://127.0.0.1:3333"]],
    ["win32", "cmd.exe", ["/d", "/s", "/c", "start", "", "http://127.0.0.1:3333"]],
    ["linux", "xdg-open", ["http://127.0.0.1:3333"]],
  ] as const)("opens the default browser on %s", async (platform, file, args) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform,
    });

    try {
      await expect(
        runWebCommand({
          createServer: () => ({
            close: async () => undefined,
            start: async () => ({ host: "127.0.0.1", port: 3333 }),
          }),
          port: 3333,
          runConversation: async () => 0,
          stdout: createOutput().stream,
        }),
      ).resolves.toBe(0);
    } finally {
      if (originalPlatform !== undefined) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    expect(spawnMock).toHaveBeenCalledWith(file, args, {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports a non-Error default browser startup failure and continues", async () => {
    const child = new EventEmitter();
    const stderr = createOutput();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", "browser unavailable"));
      return child;
    });

    await expect(
      runWebCommand({
        createServer: () => ({
          close: async () => undefined,
          start: async () => ({ host: "127.0.0.1", port: 3333 }),
        }),
        port: 3333,
        runConversation: async () => 0,
        stderr: stderr.stream,
        stdout: createOutput().stream,
      }),
    ).resolves.toBe(0);
    expect(stderr.read()).toContain("browser unavailable");
  });

  it("requires a conversation callback before starting a server", async () => {
    const createServer = vi.fn();

    await expect(
      runWebCommand({
        createServer,
        port: 3333,
      }),
    ).rejects.toThrow("interactive conversation callback");
    expect(createServer).not.toHaveBeenCalled();
  });

  it("stops a registered legacy listener and reports an idle stop", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    const reader = createRegistry(homeDir, 999);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });
    const output = createOutput();
    const killProcess = vi.fn(async (pid: number) => {
      expect(pid).toBe(123);
      await owner.unregister();
    });

    await expect(
      runWebCommand({
        killProcess,
        port: 4317,
        registry: reader,
        stdout: output.stream,
        stop: true,
      }),
    ).resolves.toBe(0);
    expect(killProcess).toHaveBeenCalledOnce();
    expect(output.read()).toContain("Yiku Web stopped: http://127.0.0.1:3333");

    await expect(
      runWebCommand({
        port: 4317,
        registry: reader,
        stdout: output.stream,
        stop: true,
      }),
    ).resolves.toBe(0);
    expect(output.read()).toContain("Yiku Web is not running.");
  });

  it("rejects unhealthy legacy registrations", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });
    const reader = new WebRegistry({
      homeDir,
      pid: 999,
      processExists: () => true,
      request: async () => Response.json({ status: "unhealthy" }, { status: 503 }),
    });

    await expect(
      runWebCommand({
        port: 4317,
        registry: reader,
        stop: true,
      }),
    ).rejects.toThrow("service is not healthy");
    await owner.unregister();
  });

  it("propagates legacy stop errors other than a missing process", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });

    await expect(
      runWebCommand({
        killProcess: () => {
          throw Object.assign(new Error("not permitted"), { code: "EPERM" });
        },
        port: 4317,
        registry: createRegistry(homeDir, 999),
        stop: true,
      }),
    ).rejects.toThrow("not permitted");
    await owner.unregister();
  });

  it("cleans a missing legacy process registration", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    let processExists = true;
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });
    const reader = new WebRegistry({
      homeDir,
      pid: 999,
      processExists: () => processExists,
      request: async () => Response.json({ status: "ok" }),
    });

    await expect(
      runWebCommand({
        killProcess: () => {
          processExists = false;
          throw Object.assign(new Error("missing"), { code: "ESRCH" });
        },
        port: 4317,
        registry: reader,
        stop: true,
      }),
    ).resolves.toBe(0);
    await expect(reader.current()).resolves.toBeUndefined();
  });

  it("uses the default process terminator for a registered legacy listener", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      rmSync(join(homeDir, ".yiku", "web.json"), { force: true });
      return true;
    });

    try {
      await expect(
        runWebCommand({
          port: 4317,
          registry: createRegistry(homeDir, 999),
          stop: true,
        }),
      ).resolves.toBe(0);
      expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("waits for a legacy registration to be removed", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    const sleep = vi.fn(async () => owner.unregister());
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });

    await expect(
      runWebCommand({
        killProcess: async () => undefined,
        port: 4317,
        registry: createRegistry(homeDir, 999),
        sleep,
        startupTimeoutMs: 1_000,
        stop: true,
      }),
    ).resolves.toBe(0);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("stops waiting when a legacy registration changes owner", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    const replacement = createRegistry(homeDir, 456);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });

    await expect(
      runWebCommand({
        killProcess: async () => {
          await replacement.register({
            endpoint: "http://127.0.0.1:4444",
            workspaceDir: "/workspace",
          });
        },
        port: 4317,
        registry: createRegistry(homeDir, 999),
        stop: true,
      }),
    ).resolves.toBe(0);
    await replacement.unregister();
  });

  it("times out while a legacy registration remains owned", async () => {
    const homeDir = await createTempDir();
    const owner = createRegistry(homeDir, 123);
    await owner.register({
      endpoint: "http://127.0.0.1:3333",
      workspaceDir: "/workspace",
    });

    await expect(
      runWebCommand({
        killProcess: async () => undefined,
        port: 4317,
        registry: createRegistry(homeDir, 999),
        startupTimeoutMs: 0,
        stop: true,
      }),
    ).rejects.toThrow("did not stop within 0ms");
    await owner.unregister();
  });
});

function addressInUse(): Error {
  return Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
}

function createRegistry(homeDir: string, pid: number): WebRegistry {
  return new WebRegistry({
    homeDir,
    pid,
    processExists: () => true,
    request: async () => Response.json({ status: "ok" }),
  });
}

function createOutput(): {
  readonly read: () => string;
  readonly stream: NodeJS.WriteStream;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  return {
    read: () => chunks.join(""),
    stream,
  };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-web-runtime-"));
  directories.push(directory);
  return directory;
}
