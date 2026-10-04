import { describe, expect, it, vi } from "vitest";
import { hashNamespace, MemoryEvents } from "../src/index.js";

describe("MemoryEvents", () => {
  it("emits bounded lifecycle metadata and ignores duplicate completion", () => {
    const handler = vi.fn();
    const events = new MemoryEvents(handler);
    const span = events.start("recall", "tenant-a", "parent");

    span.end({
      counts: {
        results: 2,
      },
      mode: "hybrid",
    });
    span.end();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      namespaceHash: hashNamespace("tenant-a"),
      operation: "recall",
      parentOperationId: "parent",
      phase: "start",
    });
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      counts: {
        results: 2,
      },
      mode: "hybrid",
      phase: "end",
    });
    expect(handler.mock.calls[1]?.[0]).not.toHaveProperty("content");
  });

  it("emits an error once and swallows observer failures", () => {
    const handler = vi.fn(() => {
      throw new Error("observer failed");
    });
    const events = new MemoryEvents(handler);
    const span = events.start("remember", "tenant");

    expect(() => span.error("MEMORY_STORE_UNAVAILABLE")).not.toThrow();
    expect(() => events.emit(handler.mock.calls[0]?.[0])).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("hashes namespaces deterministically without returning the raw value", () => {
    expect(hashNamespace("tenant")).toBe(hashNamespace("tenant"));
    expect(hashNamespace("tenant")).not.toContain("tenant");
    expect(hashNamespace("tenant")).toHaveLength(16);
  });
});
