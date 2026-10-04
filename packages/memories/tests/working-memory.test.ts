import { describe, expect, it } from "vitest";
import { InMemoryWorkingMemoryStore } from "../src/working-memory.js";

describe("InMemoryWorkingMemoryStore", () => {
  it("clones nested drafts and enforces Session ownership", async () => {
    const store = new InMemoryWorkingMemoryStore();
    const record = {
      content: "Use pnpm",
      createdAt: "2026-08-07T00:00:00.000Z",
      draft: {
        confidence: 1,
        content: "Use pnpm",
        importance: 1,
        kind: "procedure" as const,
        metadata: { stable: true },
        tags: ["tooling"],
      },
      id: "working-1",
      sessionId: "session-1",
      source: "turn-extract" as const,
      status: "active" as const,
      updatedAt: "2026-08-07T00:00:00.000Z",
    };

    const saved = await store.replace("session-1", [record]);
    expect(saved).toEqual([record]);
    expect(Object.isFrozen(saved[0]?.draft?.metadata)).toBe(true);
    expect(Object.isFrozen(saved[0]?.draft?.tags)).toBe(true);
    await expect(store.replace("session-2", [record])).rejects.toThrow("requested Session");
    await expect(store.list(" ")).rejects.toThrow("invalid");
  });
});
