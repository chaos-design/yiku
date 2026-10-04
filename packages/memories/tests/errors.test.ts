import { describe, expect, it } from "vitest";
import {
  asMemoryError,
  MemoryAbortError,
  MemoryConflictError,
  MemoryEmbeddingError,
  MemoryError,
  MemoryExtractionError,
  MemoryMigrationError,
  MemoryStoreError,
  MemoryValidationError,
  throwIfAborted,
} from "../src/index.js";

describe("memory errors", () => {
  it("preserves stable error properties and concrete names", () => {
    const cause = new Error("root");
    const errors = [
      new MemoryValidationError("MEMORY_INVALID_CONTENT", "invalid"),
      new MemoryConflictError("MEMORY_REVISION_CONFLICT", "conflict"),
      new MemoryStoreError("MEMORY_STORE_UNAVAILABLE", "store", { cause }),
      new MemoryExtractionError("MEMORY_EXTRACTION_FAILED", "extract"),
      new MemoryEmbeddingError("MEMORY_EMBEDDING_FAILED", "embed"),
      new MemoryMigrationError("MEMORY_MIGRATION_FAILED", "migrate"),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      "MemoryValidationError",
      "MemoryConflictError",
      "MemoryStoreError",
      "MemoryExtractionError",
      "MemoryEmbeddingError",
      "MemoryMigrationError",
    ]);
    expect(errors[2]?.cause).toBe(cause);
  });

  it("wraps unknown errors once", () => {
    const existing = new MemoryError("MEMORY_NOT_FOUND", "missing");

    expect(asMemoryError(existing, "recall", "fallback")).toBe(existing);
    expect(asMemoryError("failure", "remember", "write failed")).toMatchObject({
      cause: "failure",
      code: "MEMORY_STORE_UNAVAILABLE",
      operation: "remember",
    });
  });

  it("throws a typed abort error only for aborted signals", () => {
    const controller = new AbortController();

    expect(() => throwIfAborted(controller.signal, "recall")).not.toThrow();
    controller.abort();

    expect(() => throwIfAborted(controller.signal, "recall")).toThrow(MemoryAbortError);
    expect(() => throwIfAborted(controller.signal, "recall")).toThrow("was aborted");
  });
});
