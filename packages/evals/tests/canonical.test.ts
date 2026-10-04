import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  EvaluationError,
  sha256Digest,
  sha256Text,
  utf8ByteLength,
} from "../src/index.js";

describe("canonical values", () => {
  it("sorts object keys while preserving arrays and normalizing negative zero", () => {
    expect(
      canonicalStringify({
        z: -0,
        a: [{ y: 2, x: 1 }, "value"],
      }),
    ).toBe('{"a":[{"x":1,"y":2},"value"],"z":0}');
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });

  it("rejects non-finite, unsupported, accessor, and circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });

    const symbolKey = { value: 1 };
    Object.defineProperty(symbolKey, Symbol("hidden"), {
      enumerable: true,
      value: 2,
    });
    const nonEnumerable = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: 1,
    });

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      new Date(),
      accessor,
      nonEnumerable,
      symbolKey,
      circular,
    ]) {
      expect(() => canonicalStringify(value)).toThrow(EvaluationError);
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: 1,
    });
    expect(canonicalStringify(nullPrototype)).toBe('{"value":1}');
  });

  it("digests UTF-8 text without treating characters as bytes", () => {
    expect(sha256Text("same")).toHaveLength(64);
    expect(sha256Text("same")).not.toBe(sha256Text("different"));
    expect(utf8ByteLength("评测")).toBe(6);
  });
});
