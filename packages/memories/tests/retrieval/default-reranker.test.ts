import { describe, expect, it } from "vitest";
import { MemoryEmbeddingError } from "../../src/errors.js";
import { DefaultMemoryPolicy } from "../../src/policy/default-policy.js";
import {
  cosineSimilarity,
  DefaultMemoryReranker,
  toMemoryRecord,
} from "../../src/retrieval/default-reranker.js";
import type { MemoryCandidateSet, StoredMemory } from "../../src/types.js";

describe("cosineSimilarity", () => {
  it("calculates normalized similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("rejects malformed vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(MemoryEmbeddingError);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow("equal non-zero");
    expect(() => cosineSimilarity([Number.NaN], [1])).toThrow("finite");
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow("non-zero magnitude");
  });
});

describe("DefaultMemoryReranker", () => {
  const reranker = new DefaultMemoryReranker();
  const policy = new DefaultMemoryPolicy({
    kindResultLimit: 2,
  });

  it("fuses lexical and semantic ranks with explainable quality factors", () => {
    const first = memory({
      confidence: 0.9,
      id: "first",
      importance: 0.8,
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
    const second = memory({
      accessCount: 10,
      confidence: 0.2,
      id: "second",
      importance: 0.2,
      kind: "decision",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const candidates: MemoryCandidateSet = {
      lexical: [
        { memory: first, rank: 1, score: 0.9 },
        { memory: second, rank: 2, score: 0.5 },
      ],
      vector: [
        { memory: second, rank: 1, score: 0.95 },
        { memory: first, rank: 2, score: 0.8 },
      ],
      vectorScanExceeded: false,
    };

    const results = reranker.rerank({
      candidates,
      kindResultLimit: policy.kindResultLimit,
      limit: 10,
      maxChars: 1_000,
      now: "2026-07-31T00:00:00.000Z",
      policy,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["first", "second"]);
    expect(results[0]?.reasons).toEqual([
      "LEXICAL_MATCH",
      "SEMANTIC_MATCH",
      "HIGH_CONFIDENCE",
      "HIGH_IMPORTANCE",
      "RECENT",
    ]);
    expect(results[1]?.scores.access).toBeLessThan(1);
    expect(results[1]?.scores.vector).toBe(0.95);
  });

  it("deduplicates fingerprints and enforces kind, result, and character limits", () => {
    const candidates: MemoryCandidateSet = {
      lexical: [
        { memory: memory({ fingerprint: "same", id: "a" }), rank: 1, score: 1 },
        { memory: memory({ fingerprint: "same", id: "b" }), rank: 2, score: 0.9 },
        { memory: memory({ id: "c" }), rank: 3, score: 0.8 },
        {
          memory: memory({ content: "too large", id: "d", kind: "decision" }),
          rank: 4,
          score: 0.7,
        },
      ],
      vector: [],
      vectorScanExceeded: false,
    };

    const results = reranker.rerank({
      candidates,
      kindResultLimit: 1,
      limit: 2,
      maxChars: 8,
      now: "2026-07-31T00:00:00.000Z",
      policy,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["a"]);
  });

  it("uses stable recency and ID tie breakers", () => {
    const older = memory({ id: "z", updatedAt: "2026-07-29T00:00:00.000Z" });
    const newerB = memory({ id: "b" });
    const newerA = memory({ id: "a" });

    const results = reranker.rerank({
      candidates: {
        lexical: [
          { memory: older, rank: 1, score: 1 },
          { memory: newerB, rank: 1, score: 1 },
          { memory: newerA, rank: 1, score: 1 },
        ],
        vector: [],
        vectorScanExceeded: false,
      },
      kindResultLimit: 10,
      limit: 10,
      maxChars: 1_000,
      now: "2026-07-31T00:00:00.000Z",
      policy: new DefaultMemoryPolicy({ recencyHalfLifeDays: 30 }),
    });

    expect(results.map((result) => result.memory.id)).toEqual(["a", "b", "z"]);
  });

  it("projects stored records without internal index data", () => {
    const stored = memory({
      embedding: {
        dimensions: 2,
        model: "test",
        values: [1, 0],
      },
      expiresAt: "2027-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(toMemoryRecord(stored)).toMatchObject({
      expiresAt: "2027-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(toMemoryRecord(stored)).not.toHaveProperty("embedding");
    expect(toMemoryRecord(stored)).not.toHaveProperty("fingerprint");
  });
});

function memory(overrides: Partial<StoredMemory>): StoredMemory {
  const id = overrides.id ?? "memory";

  return {
    accessCount: 0,
    confidence: 0.5,
    content: "memory",
    createdAt: "2026-07-31T00:00:00.000Z",
    fingerprint: overrides.fingerprint ?? id,
    id,
    importance: 0.5,
    kind: "fact",
    metadata: {},
    namespace: "tenant",
    normalizedContent: "memory",
    revision: 1,
    scope: {},
    scopeKey: "scope",
    source: {
      type: "user",
    },
    status: "active",
    tags: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}
