import { describe, expect, it } from "vitest";
import { hookSource } from "../../src/config/source.js";
import {
  canonicalJson,
  createTrustKey,
  type HookTrustDescriptor,
  sha256,
} from "../../src/trust/canonical.js";

describe("trust canonicalization", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, values: [2, 1] })).toBe(
      '{"a":{"b":3,"y":2},"values":[2,1],"z":1}',
    );
  });

  it("generates stable keys independent of object insertion order", () => {
    const descriptor = trustDescriptor();
    const reordered = {
      source: descriptor.source,
      opaque: descriptor.opaque,
      hookId: descriptor.hookId,
      handlerHash: descriptor.handlerHash,
      executorType: descriptor.executorType,
      capability: descriptor.capability,
    } satisfies HookTrustDescriptor;

    expect(createTrustKey(descriptor)).toBe(createTrustKey(reordered));
    expect(createTrustKey(descriptor)).toMatch(/^trust_[a-f0-9]{32}$/u);
  });

  it("changes keys when a capability or script hash changes", () => {
    const descriptor = trustDescriptor();

    expect(createTrustKey({ ...descriptor, capability: "https://other.test" })).not.toBe(
      createTrustKey(descriptor),
    );
    expect(
      createTrustKey({
        ...descriptor,
        scriptHashes: { "/hook.mjs": sha256("new") },
      }),
    ).not.toBe(createTrustKey(descriptor));
  });
});

function trustDescriptor(): HookTrustDescriptor {
  return {
    capability: "node hook.mjs",
    executorType: "command",
    handlerHash: sha256("handler"),
    hookId: "hook-1",
    opaque: true,
    source: hookSource("project", { path: "/workspace/.yiku/settings.json" }),
  };
}
