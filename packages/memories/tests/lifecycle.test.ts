import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMemoryStore,
  InMemoryWorkingMemoryStore,
  MemoryLifecycle,
  MemoryManager,
  workingMemorySourceLabel,
} from "../src/index.js";

const context = {
  namespace: "project",
  scope: {
    projectId: "repo",
  },
} as const;

describe("MemoryLifecycle", () => {
  it("captures redacted Working Memory idempotently and searches it", async () => {
    const lifecycle = createLifecycle();

    const first = await lifecycle.captureWorking({
      content: "Use token=secret-value for pnpm",
      sessionId: "session-1",
      source: "task",
    });
    const second = await lifecycle.captureWorking({
      content: "Use token=secret-value for pnpm",
      sessionId: "session-1",
      source: "task",
    });
    const results = await lifecycle.search({
      classes: ["working"],
      context,
      query: "pnpm",
      sessionId: "session-1",
    });

    expect(second.id).toBe(first.id);
    expect(second.content).toContain("[REDACTED]");
    expect(await lifecycle.listWorking("session-1")).toHaveLength(1);
    expect(results).toMatchObject([
      {
        class: "working",
        tier: "working",
        workingMemory: {
          id: first.id,
        },
      },
    ]);
  });

  it("extracts candidates into Working Memory and consolidates them idempotently", async () => {
    const extractor = {
      extract: vi.fn(async () => [
        {
          confidence: 0.9,
          content: "Use pnpm for this repository.",
          importance: 0.8,
          kind: "procedure" as const,
        },
      ]),
    };
    const lifecycle = createLifecycle(extractor);

    const extracted = await lifecycle.extractToWorking({
      context,
      output: "pnpm test passed",
      prompt: "Run tests",
      sessionId: "session-1",
    });
    await expect(lifecycle.status("session-1")).resolves.toMatchObject({
      pendingConsolidation: 1,
      working: 1,
    });
    const first = await lifecycle.consolidate({
      context,
      sessionId: "session-1",
    });
    const second = await lifecycle.consolidate({
      context,
      sessionId: "session-1",
    });

    expect(extracted.workingMemories).toHaveLength(1);
    expect(extractor.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        workingMemories: [],
      }),
      expect.any(Object),
    );
    expect(first).toMatchObject({
      consolidated: 1,
      discarded: 0,
      failed: 0,
      pending: 0,
    });
    expect(first.memories[0]).toMatchObject({
      kind: "procedure",
    });
    expect(second.consolidated).toBe(0);
    await expect(lifecycle.status("session-1", context)).resolves.toMatchObject({
      longTerm: {
        procedure: 1,
        scenario: 0,
        semantic: 0,
      },
      pendingConsolidation: 0,
      working: 1,
    });
    expect(await lifecycle.listWorking("session-1")).toMatchObject([
      {
        longTermMemoryId: first.memories[0]?.id,
        status: "consolidated",
      },
    ]);
  });

  it("merges Working and long-term search, forgets both tiers, and emits lifecycle atoms", async () => {
    const flow = new AtomicFlowRun({ runId: "memory-lifecycle" });
    const lifecycle = createLifecycle();
    const working = await lifecycle.captureWorking({
      atomicFlow: flow,
      content: "Current TypeScript migration",
      sessionId: "session-1",
      source: "prompt",
    });
    await lifecycle.captureWorking({
      atomicFlow: flow,
      content: "Keep TypeScript strict",
      draft: {
        confidence: 0.9,
        content: "Keep TypeScript strict",
        importance: 0.8,
        kind: "fact",
      },
      sessionId: "session-1",
      source: "turn-extract",
    });
    const consolidated = await lifecycle.consolidate({
      atomicFlow: flow,
      context,
      sessionId: "session-1",
    });
    const results = await lifecycle.recall({
      atomicFlow: flow,
      context,
      query: "TypeScript",
      sessionId: "session-1",
    });

    expect(results.map((result) => result.class)).toEqual(["working", "working"]);
    expect(results.map((result) => result.content)).toEqual(
      expect.arrayContaining(["Current TypeScript migration", "Keep TypeScript strict"]),
    );
    await expect(
      lifecycle.forget({
        atomicFlow: flow,
        context,
        id: working.id,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      forgotten: true,
      tier: "working",
    });
    await expect(
      lifecycle.forget({
        atomicFlow: flow,
        context,
        id: consolidated.memories[0]?.id ?? "",
        mode: "hard",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      forgotten: true,
      tier: "long-term",
    });

    expect(flow.snapshot().events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "memory.working-capture",
        "memory.working",
        "memory.consolidate",
        "memory.semantic",
        "memory.write",
        "memory.recall",
        "memory.search",
        "memory.forget",
      ]),
    );
  });

  it("discards low-confidence candidates and exposes bounded maintenance operations", async () => {
    const lifecycle = createLifecycle();
    await lifecycle.captureWorking({
      content: "Temporary progress",
      draft: {
        confidence: 0.1,
        content: "Temporary progress",
        expiresAt: "2026-08-08T00:00:00.000Z",
        importance: 0.2,
        kind: "episode",
        metadata: { temporary: true },
        tags: ["temporary"],
      },
      sessionId: "session-1",
      source: "turn-extract",
    });
    const result = await lifecycle.consolidate({
      context,
      sessionId: "session-1",
    });

    expect(result).toMatchObject({
      consolidated: 0,
      discarded: 1,
      failed: 0,
      pending: 0,
    });
    await expect(lifecycle.status("session-1")).resolves.toMatchObject({
      longTerm: {
        procedure: 0,
        scenario: 0,
        semantic: 0,
      },
      working: 0,
    });
    await expect(
      lifecycle.forget({
        context,
        id: "missing",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      forgotten: false,
      id: "missing",
      mode: "soft",
    });
    await expect(
      lifecycle.prune({
        before: "2026-08-08T00:00:00.000Z",
        context,
      }),
    ).resolves.toEqual({ deleted: 0 });
    await expect(lifecycle.clearWorking("session-1")).resolves.toEqual([]);
  });

  it("retains failed candidates for consolidation retries", async () => {
    const manager = new MemoryManager({
      idGenerator: createIdGenerator("long"),
      store: new InMemoryMemoryStore(),
    });
    const remember = vi.spyOn(manager, "remember").mockRejectedValueOnce(new Error("offline"));
    const lifecycle = new MemoryLifecycle({
      idGenerator: createIdGenerator("working"),
      manager,
    });
    await lifecycle.captureWorking({
      content: "Use pnpm",
      draft: {
        confidence: 0.9,
        content: "Use pnpm",
        expiresAt: "2026-09-01T00:00:00.000Z",
        importance: 0.8,
        kind: "procedure",
        metadata: { stable: true },
        tags: ["tooling"],
      },
      sessionId: "session-1",
      source: "turn-extract",
    });

    await expect(
      lifecycle.consolidate({
        context,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      consolidated: 0,
      failed: 1,
      pending: 1,
    });
    await expect(
      lifecycle.consolidate({
        context,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      consolidated: 1,
      failed: 0,
      pending: 0,
    });
    expect(remember).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("validates Working identifiers and Search classes", async () => {
    const lifecycle = createLifecycle();

    await expect(
      lifecycle.captureWorking({
        content: "content",
        sessionId: "",
        source: "prompt",
      }),
    ).rejects.toThrow("Session ID");
    await expect(
      lifecycle.search({
        classes: ["invalid" as never],
        context,
        query: "content",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Class");
  });

  it("covers filtered Search, duplicate updates, and source labels", async () => {
    const manager = new MemoryManager({
      idGenerator: createIdGenerator("long"),
      store: new InMemoryMemoryStore(),
    });
    await manager.remember({
      content: "Stable TypeScript fact",
      context,
      kind: "fact",
    });
    const lifecycle = new MemoryLifecycle({
      idGenerator: createIdGenerator("working"),
      manager,
    });
    await lifecycle.captureWorking({
      content: "Current task",
      sessionId: "session-1",
      source: "task",
    });
    await lifecycle.captureWorking({
      content: "Other task",
      sessionId: "session-1",
      source: "task",
    });
    const updated = await lifecycle.captureWorking({
      content: "Current task",
      draft: {
        confidence: 0.9,
        content: "Current task",
        importance: 0.8,
        kind: "episode",
      },
      sessionId: "session-1",
      source: "task",
    });

    expect(updated.draft?.kind).toBe("episode");
    await expect(
      lifecycle.search({
        classes: ["semantic"],
        context,
        query: "TypeScript",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject([
      {
        class: "semantic",
        tier: "long-term",
      },
    ]);
    await expect(
      lifecycle.search({
        classes: ["scenario"],
        context,
        query: "TypeScript",
        sessionId: "session-1",
      }),
    ).resolves.toEqual([]);
    await expect(
      lifecycle.search({
        classes: [],
        context,
        query: "none",
        sessionId: "session-1",
      }),
    ).resolves.toEqual([]);
    await expect(
      lifecycle.search({
        classes: ["working"],
        context,
        query: "!!!",
        sessionId: "session-1",
      }),
    ).resolves.toEqual([]);
    await expect(
      lifecycle.recall({
        classes: ["invalid" as never],
        context,
        query: "fact",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Class");
    expect(
      ["operation", "prompt", "task", "turn-extract", "user-answer"].map((source) =>
        workingMemorySourceLabel(source as never),
      ),
    ).toEqual(["Operation", "Prompt", "Task", "Turn Extract", "User Answer"]);
    await manager.close();
  });

  it("reports non-Error capture failures on linked Flow spans", async () => {
    const flow = new AtomicFlowRun({ runId: "capture-failure" });
    const lifecycle = new MemoryLifecycle({
      manager: new MemoryManager({
        store: new InMemoryMemoryStore(),
      }),
      workingStore: {
        list: async () => [],
        replace: async () => Promise.reject("offline"),
      },
    });

    await expect(
      lifecycle.captureWorking({
        atomicFlow: flow,
        atomicParentInstanceId: "missing-parent",
        content: "content",
        sessionId: "session-1",
        source: "prompt",
      }),
    ).rejects.toBe("offline");
    expect(flow.snapshot().events.at(-1)).toMatchObject({
      atom: {
        key: "memory.working-capture",
      },
      payload: {
        summary: "offline",
      },
      phase: "error",
    });
    await flow.close();
  });
});

function createLifecycle(extractor?: {
  readonly extract: ReturnType<typeof vi.fn>;
}): MemoryLifecycle {
  const manager = new MemoryManager({
    ...(extractor !== undefined ? { extractor } : {}),
    idGenerator: createIdGenerator("long"),
    store: new InMemoryMemoryStore(),
  });
  return new MemoryLifecycle({
    idGenerator: createIdGenerator("working"),
    manager,
    workingStore: new InMemoryWorkingMemoryStore(),
  });
}

function createIdGenerator(prefix: string): () => string {
  let id = 0;
  return () => {
    id += 1;
    return `${prefix}-${id}`;
  };
}
