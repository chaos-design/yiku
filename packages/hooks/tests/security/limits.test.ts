import { describe, expect, it } from "vitest";
import { HookConfigError } from "../../src/errors.js";
import { DEFAULT_HOOK_RESOURCE_LIMITS, HookLimits } from "../../src/security/limits.js";

describe("HookLimits", () => {
  it("uses frozen conservative defaults and accepts overrides", () => {
    const limits = new HookLimits({ maxConcurrentHandlers: 2 });

    expect(limits.maxConcurrentHandlers).toBe(2);
    expect(limits.maxInputBytes).toBe(DEFAULT_HOOK_RESOURCE_LIMITS.maxInputBytes);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(DEFAULT_HOOK_RESOURCE_LIMITS)).toBe(true);
  });

  it("rejects zero, negative, fractional, and unsafe limits", () => {
    for (const value of [0, -1, 1.5, Number.MAX_VALUE]) {
      expect(() => new HookLimits({ maxConcurrentHandlers: value })).toThrow(HookConfigError);
    }
  });
});
