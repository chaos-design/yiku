import { describe, expect, it } from "vitest";
import { MemoryValidationError } from "../../src/errors.js";
import {
  canonicalJson,
  createFingerprint,
  createIdempotencyHash,
  createScopeKey,
  DEFAULT_MEMORY_POLICY,
  DefaultMemoryPolicy,
  normalizeContent,
  validateContent,
  validateContext,
  validateDate,
  validateKind,
  validateMetadata,
  validatePositiveInteger,
  validateScore,
  validateSource,
  validateTags,
} from "../../src/policy/index.js";
import type { JsonValue, MemoryKind } from "../../src/types.js";

describe("DefaultMemoryPolicy", () => {
  it("provides frozen defaults and supports explicit overrides", () => {
    const policy = new DefaultMemoryPolicy({
      defaultRecallLimit: 4,
      embeddingFailureMode: "error",
    });

    expect(policy.defaultRecallLimit).toBe(4);
    expect(policy.embeddingFailureMode).toBe("error");
    expect(policy.maxContentBytes).toBe(DEFAULT_MEMORY_POLICY.maxContentBytes);
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe("memory validation", () => {
  const policy = new DefaultMemoryPolicy({
    maxContentBytes: 20,
    maxMetadataBytes: 100,
    maxMetadataDepth: 3,
    maxScopeValueBytes: 8,
    maxTagBytes: 8,
    maxTags: 3,
    namespaceMaxBytes: 8,
  });

  it("normalizes contexts, content, kinds, scores, and dates", () => {
    expect(
      validateContext(
        {
          namespace: " tenant ",
          scope: {
            projectId: " repo ",
          },
        },
        policy,
      ),
    ).toEqual({
      namespace: "tenant",
      scope: {
        projectId: "repo",
      },
    });
    expect(validateContent("  cafe\u0301\r\nline  ", policy)).toBe("caf\u00e9\nline");
    expect(normalizeContent(" a\t \tb\r\nc ")).toBe("a b\nc");
    expect(validateKind("fact")).toBe("fact");
    expect(validateScore(undefined, 0.5)).toBe(0.5);
    expect(validateScore(1, 0)).toBe(1);
    expect(validatePositiveInteger(2, 3, "limit")).toBe(2);
    expect(validateDate("2026-07-31", "date")).toBe("2026-07-31T00:00:00.000Z");
  });

  it("rejects malformed contexts and scalar values", () => {
    expect(() => validateContext(null as never, policy)).toThrow(MemoryValidationError);
    expect(() => validateContext({ namespace: "" }, policy)).toThrow("non-empty");
    expect(() => validateContext({ namespace: "too-long!" }, policy)).toThrow("exceeds");
    expect(() => validateContext({ namespace: "tenant", scope: null as never }, policy)).toThrow(
      "scope",
    );
    expect(() =>
      validateContext(
        {
          namespace: "tenant",
          scope: {
            userId: "too-long!",
          },
        },
        policy,
      ),
    ).toThrow("exceeds");
    expect(() => validateContent("", policy)).toThrow("non-empty");
    expect(() => validateContent("this content is much too long", policy)).toThrow("exceeds");
    expect(() => validateKind("unknown" as MemoryKind)).toThrow("Unsupported");
    expect(() => validateScore(Number.NaN, 0)).toThrow("finite");
    expect(() => validateScore(1.1, 0)).toThrow("finite");
    expect(() => validatePositiveInteger(0, 3, "limit")).toThrow("positive");
    expect(() => validatePositiveInteger(4, 3, "limit")).toThrow("positive");
    expect(() => validateDate("", "date")).toThrow("valid date");
    expect(() => validateDate("invalid", "date")).toThrow("valid date");
  });

  it("normalizes and validates tags and sources", () => {
    expect(validateTags(undefined, policy)).toEqual([]);
    expect(validateTags([" beta ", "alpha", "alpha"], policy)).toEqual(["alpha", "beta"]);
    expect(validateSource(undefined)).toEqual({ type: "user" });
    expect(validateSource({ id: " session ", type: "session" })).toEqual({
      id: "session",
      type: "session",
    });
    expect(validateSource({ id: " ", type: "tool" })).toEqual({ type: "tool" });

    expect(() => validateTags(["a", "b", "c", "d"], policy)).toThrow("no more");
    expect(() => validateTags([""], policy)).toThrow("non-empty");
    expect(() => validateTags(["too-long!"], policy)).toThrow("exceeds");
    expect(() => validateSource({ type: "bad" as never })).toThrow("source type");
  });

  it("copies JSON-safe metadata and rejects unsafe structures", () => {
    const metadata = Object.create(null) as Record<string, JsonValue>;
    metadata.z = [true, null, 1];
    metadata.a = {
      value: "ok",
    };

    expect(validateMetadata(undefined, policy)).toEqual({});
    expect(validateMetadata(metadata, policy)).toEqual({
      a: {
        value: "ok",
      },
      z: [true, null, 1],
    });
    expect(() => validateMetadata([] as never, policy)).toThrow("JSON object");
    expect(() => validateMetadata({ value: Number.NaN } as never, policy)).toThrow("finite");
    expect(() => validateMetadata({ value: 1n } as never, policy)).toThrow("non-JSON");
    expect(() =>
      validateMetadata({ nested: { too: { deeply: { nested: true } } } }, policy),
    ).toThrow("nested too deeply");
    expect(() => validateMetadata(new Date() as never, policy)).toThrow("plain prototype");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateMetadata(cyclic as never, policy)).toThrow("cyclic");

    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "value",
    });
    expect(() => validateMetadata(accessor, policy)).toThrow("accessors");
    expect(() => validateMetadata({ value: "x".repeat(100) }, policy)).toThrow("exceeds");
  });

  it("creates stable canonical identities", () => {
    expect(canonicalJson({ b: 2, a: [1, "x"] })).toBe('{"a":[1,"x"],"b":2}');
    expect(
      createScopeKey({
        projectId: "repo",
      }),
    ).toBe(
      createScopeKey({
        projectId: "repo",
      }),
    );
    expect(createFingerprint("fact", "content")).not.toBe(createFingerprint("decision", "content"));
    expect(createIdempotencyHash({ a: 1, b: 2 })).toBe(createIdempotencyHash({ b: 2, a: 1 }));
  });
});
