import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryExtractor } from "@yiku/memories";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRuntime } from "../../src/session/memory-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("MemoryRuntime", () => {
  it("does not create a Store when Memory is disabled", async () => {
    const storeFactory = vi.fn();
    const runtime = new MemoryRuntime({
      agentId: "code",
      enabled: false,
      sessionId: "session-1",
      storeFactory,
      workspaceDir: "/workspace",
    });

    expect(runtime.sessionOptions()).toBeUndefined();
    expect(storeFactory).not.toHaveBeenCalled();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("owns a project SQLite Manager with lexical recall by default", async () => {
    const workspaceDir = await temporaryDirectory();
    const filePath = join(await temporaryDirectory(), ".yiku", "memory", "memories.sqlite");
    const runtime = new MemoryRuntime({
      agentId: "code",
      enabled: true,
      extraction: true,
      filePath,
      sessionId: "session-1",
      workspaceDir,
    });
    const options = runtime.sessionOptions();

    expect(options).toMatchObject({
      context: {
        scope: {
          agentId: "code",
        },
      },
      extraction: {
        enabled: false,
      },
      failureMode: "best-effort",
    });
    await options?.manager.remember({
      content: "Use pnpm",
      context: options.context,
      kind: "procedure",
    });
    expect(existsSync(filePath)).toBe(true);
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("enables extraction only when an Extractor is configured", async () => {
    const workspaceDir = await temporaryDirectory();
    const filePath = join(workspaceDir, "custom", "memory.sqlite");
    const extractor: MemoryExtractor = {
      extract: vi.fn(async () => []),
    };
    const onError = vi.fn();
    const onEvent = vi.fn();
    const runtime = new MemoryRuntime({
      agentId: "reviewer",
      enabled: true,
      extraction: true,
      extractor,
      failureMode: "strict",
      filePath,
      namespace: "custom-namespace",
      onError,
      onEvent,
      sessionId: "session-1",
      workspaceDir,
    });

    expect(runtime.sessionOptions()).toMatchObject({
      context: {
        namespace: "custom-namespace",
        scope: {
          agentId: "reviewer",
        },
      },
      extraction: {
        enabled: true,
      },
      failureMode: "strict",
      onError,
    });
    const options = runtime.sessionOptions();
    if (options !== undefined) {
      await options.manager.remember({
        content: "custom memory",
        context: options.context,
        kind: "fact",
      });
    }
    expect(onEvent).toHaveBeenCalled();
    expect(existsSync(filePath)).toBe(true);
    await runtime.close();
  });

  it("rejects empty enabled Memory scope identifiers", () => {
    expect(
      () =>
        new MemoryRuntime({
          agentId: " ",
          enabled: true,
          sessionId: "session-1",
          workspaceDir: "/workspace",
        }),
    ).toThrow("Memory Agent ID is required");
    expect(
      () =>
        new MemoryRuntime({
          agentId: "code",
          enabled: true,
          sessionId: "",
          workspaceDir: "/workspace",
        }),
    ).toThrow("Memory Session ID is required");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-memory-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
