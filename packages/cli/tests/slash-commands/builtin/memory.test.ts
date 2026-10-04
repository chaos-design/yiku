import { describe, expect, it, vi } from "vitest";
import { memoryCommand } from "../../../src/slash-commands/builtin/memory.js";

describe("/memory", () => {
  it("shows lifecycle status and validates search classes", async () => {
    const controller = {
      consolidate: vi.fn(),
      forget: vi.fn(),
      search: vi.fn(async () => []),
      status: vi.fn(async () => ({
        longTerm: {
          procedure: 2,
          scenario: 3,
          semantic: 4,
        },
        pendingConsolidation: 1,
        working: 5,
      })),
    };
    const context = {
      getMemoryController: vi.fn(async () => controller),
    } as never;

    await expect(execute(context, ["status"])).resolves.toMatchObject({
      kind: "success",
      message: expect.stringContaining("Working: 5"),
    });
    await expect(
      execute(context, ["search", "--class", "invalid", "query"]),
    ).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("Memory class"),
    });
  });

  it("searches by class, consolidates, and forgets explicitly", async () => {
    const controller = {
      consolidate: vi.fn(async () => ({
        consolidated: 2,
        discarded: 1,
        failed: 0,
        memories: [],
        pending: 0,
      })),
      forget: vi.fn(async () => ({
        forgotten: true,
        id: "memory-1",
        mode: "hard",
        tier: "long-term",
      })),
      search: vi.fn(async () => [
        {
          class: "semantic",
          content: "Use TypeScript",
          memory: { id: "memory-1" },
          reasons: [],
          score: 0.8,
          scores: {},
          tier: "long-term",
        },
      ]),
      status: vi.fn(),
    };
    const context = {
      getMemoryController: vi.fn(async () => controller),
    } as never;

    await expect(
      execute(context, ["search", "--class", "semantic", "TypeScript"]),
    ).resolves.toMatchObject({
      kind: "success",
      message: expect.stringContaining("memory-1 [semantic] 0.800 Use TypeScript"),
    });
    expect(controller.search).toHaveBeenCalledWith("TypeScript", {
      classes: ["semantic"],
    });
    await expect(execute(context, ["consolidate"])).resolves.toMatchObject({
      message: expect.stringContaining("Consolidated: 2"),
    });
    await expect(execute(context, ["forget", "--hard", "memory-1"])).resolves.toMatchObject({
      message: "Forgot memory-1 (long-term, hard).",
    });
    expect(controller.forget).toHaveBeenCalledWith("memory-1", true);
  });

  it("covers unavailable, empty, bounded, and invalid command branches", async () => {
    const unavailable = {
      getMemoryController: vi.fn(async () => undefined),
    } as never;
    await expect(execute(unavailable, ["status"])).resolves.toMatchObject({
      kind: "error",
      message: "Memory is disabled or unavailable.",
    });

    const controller = {
      consolidate: vi.fn(),
      forget: vi.fn(async () => ({
        forgotten: false,
        id: "missing",
        mode: "soft",
      })),
      search: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            class: "working",
            content: `line one\n${"x".repeat(220)}`,
            reasons: ["WORKING_MATCH"],
            score: 1,
            tier: "working",
            workingMemory: { id: "working-1" },
          },
        ]),
      status: vi.fn(),
    };
    const context = {
      getMemoryController: vi.fn(async () => controller),
    } as never;

    await expect(execute(context, [])).resolves.toMatchObject({ kind: "error" });
    await expect(execute(context, ["status", "extra"])).resolves.toMatchObject({ kind: "error" });
    await expect(execute(context, ["consolidate", "extra"])).resolves.toMatchObject({
      kind: "error",
    });
    await expect(execute(context, ["search", "none"])).resolves.toMatchObject({
      message: "No matching memories.",
    });
    await expect(execute(context, ["search", "long"])).resolves.toMatchObject({
      message: expect.stringMatching(/^working-1 \[working\] 1\.000 line one x+\.\.\.$/u),
    });
    await expect(execute(context, ["search"])).resolves.toMatchObject({ kind: "error" });
    await expect(execute(context, ["search", "--class"])).resolves.toMatchObject({
      kind: "error",
    });
    await expect(execute(context, ["forget", "missing"])).resolves.toMatchObject({
      message: "Memory not found: missing.",
    });
    await expect(execute(context, ["forget"])).resolves.toMatchObject({ kind: "error" });
    await expect(execute(context, ["forget", "--hard", "id", "extra"])).resolves.toMatchObject({
      kind: "error",
    });
    expect(controller.search).toHaveBeenNthCalledWith(1, "none", {});
    expect(controller.forget).toHaveBeenCalledWith("missing", false);
  });
});

function execute(context: never, values: readonly string[]) {
  return memoryCommand.execute(context, {
    raw: values.join(" "),
    values,
  });
}
