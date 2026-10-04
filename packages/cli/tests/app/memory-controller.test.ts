import { describe, expect, it, vi } from "vitest";
import { MemoryController } from "../../src/app/memory-controller.js";

describe("MemoryController", () => {
  it("delegates status and operations with optional filters", async () => {
    const lifecycle = lifecycleMock();
    const controller = controllerFor(lifecycle);

    await controller.status();
    await controller.search("TypeScript");
    await controller.search("pnpm", {
      classes: ["procedure"],
      limit: 2,
      maxChars: 500,
    });
    await controller.consolidate();
    await controller.forget("working-1");
    await controller.forget("memory-1", true);

    expect(lifecycle.status).toHaveBeenCalledWith("session-1", { namespace: "project" });
    expect(lifecycle.search).toHaveBeenNthCalledWith(1, {
      context: { namespace: "project" },
      query: "TypeScript",
      sessionId: "session-1",
    });
    expect(lifecycle.search).toHaveBeenNthCalledWith(2, {
      classes: ["procedure"],
      context: { namespace: "project" },
      limit: 2,
      maxChars: 500,
      query: "pnpm",
      sessionId: "session-1",
    });
    expect(lifecycle.consolidate).toHaveBeenCalledWith({
      context: { namespace: "project" },
      sessionId: "session-1",
    });
    expect(lifecycle.forget).toHaveBeenNthCalledWith(1, {
      context: { namespace: "project" },
      id: "working-1",
      mode: "soft",
      sessionId: "session-1",
    });
    expect(lifecycle.forget).toHaveBeenNthCalledWith(2, {
      context: { namespace: "project" },
      id: "memory-1",
      mode: "hard",
      sessionId: "session-1",
    });
  });

  it("closes observed flows after success and failure", async () => {
    const lifecycle = lifecycleMock();
    const close = vi.fn(async () => undefined);
    const flow = { close } as never;
    const createFlow = vi.fn(() => flow);
    const controller = controllerFor(lifecycle, createFlow);

    await controller.search("query");
    expect(createFlow).toHaveBeenCalledWith("/memory search query");
    expect(lifecycle.search).toHaveBeenCalledWith(
      expect.objectContaining({
        atomicFlow: flow,
      }),
    );
    expect(close).toHaveBeenCalledOnce();

    await controller.forget("memory-1", true);
    expect(lifecycle.forget).toHaveBeenCalledWith(
      expect.objectContaining({
        atomicFlow: flow,
      }),
    );
    expect(close).toHaveBeenCalledTimes(2);

    lifecycle.consolidate.mockRejectedValueOnce(new Error("failed"));
    await expect(controller.consolidate()).rejects.toThrow("failed");
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("rejects missing lifecycle configuration", async () => {
    expect(
      () =>
        new MemoryController({
          memories: {
            context: { namespace: "project" },
            manager: {},
          } as never,
          sessionId: "session-1",
        }),
    ).toThrow("unavailable");

    const memories = {
      context: { namespace: "project" },
      lifecycle: lifecycleMock(),
      manager: {},
    };
    const controller = new MemoryController({
      memories: memories as never,
      sessionId: "session-1",
    });
    memories.lifecycle = undefined as never;
    expect(() => controller.status()).toThrow("unavailable");
  });
});

function lifecycleMock() {
  return {
    consolidate: vi.fn(async () => ({
      consolidated: 0,
      discarded: 0,
      failed: 0,
      memories: [],
      pending: 0,
    })),
    forget: vi.fn(async () => ({
      forgotten: true,
      id: "memory",
      mode: "soft" as const,
      tier: "working" as const,
    })),
    search: vi.fn(async () => []),
    status: vi.fn(async () => ({
      longTerm: { procedure: 0, scenario: 0, semantic: 0 },
      pendingConsolidation: 0,
      working: 0,
    })),
  };
}

function controllerFor(
  lifecycle: ReturnType<typeof lifecycleMock>,
  createFlow?: (() => never) | undefined,
): MemoryController {
  return new MemoryController({
    ...(createFlow !== undefined ? { createFlow } : {}),
    memories: {
      context: { namespace: "project" },
      lifecycle,
      manager: {},
    } as never,
    sessionId: "session-1",
  });
}
