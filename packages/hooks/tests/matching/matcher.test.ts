import { describe, expect, it } from "vitest";
import { HookMatcherError } from "../../src/errors.js";
import { HookMatcher } from "../../src/matching/matcher.js";

describe("HookMatcher", () => {
  it("matches all for missing, empty, and wildcard patterns", () => {
    for (const pattern of [undefined, "", "  ", "*"]) {
      const matcher = new HookMatcher(pattern);

      expect(matcher.mode).toBe("all");
      expect(matcher.matches("Bash")).toBe(true);
    }
  });

  it("matches exact values separated by pipes or commas", () => {
    const matcher = new HookMatcher("Edit | Write, Bash");

    expect(matcher.mode).toBe("exact");
    expect(matcher.matches("Edit")).toBe(true);
    expect(matcher.matches("Write")).toBe(true);
    expect(matcher.matches("Bash")).toBe(true);
    expect(matcher.matches("NotebookEdit")).toBe(false);
    expect(matcher.matches("edit")).toBe(false);
  });

  it("uses an unanchored regexp when special characters are present", () => {
    const matcher = new HookMatcher("mcp__memory__.*");

    expect(matcher.mode).toBe("regexp");
    expect(matcher.matches("mcp__memory__create_entities")).toBe(true);
    expect(matcher.matches("mcp__filesystem__read_file")).toBe(false);
  });

  it("rejects malformed, oversized, and unsafe regexps", () => {
    expect(() => new HookMatcher("[")).toThrow(HookMatcherError);
    expect(() => new HookMatcher("(a+)+")).toThrow("unsafe nested quantifier");
    expect(() => new HookMatcher("x".repeat(1_025))).toThrow("exceeds 1024");
  });
});
