import { describe, expect, it } from "vitest";
import { HookMatcherError } from "../../src/errors.js";
import { HookCondition } from "../../src/matching/condition.js";

describe("HookCondition", () => {
  it("matches Bash subcommands conservatively", () => {
    const condition = new HookCondition("Bash(git *)");

    expect(condition.matches("Bash", { command: "echo before && git status" })).toBe(true);
    expect(condition.matches("Bash", { command: "pnpm test" })).toBe(false);
    expect(condition.matches("Edit", { command: "git status" })).toBe(false);
  });

  it("matches file and path candidates using glob syntax", () => {
    const condition = new HookCondition("Edit(*.ts)");

    expect(condition.matches("Edit", { file_path: "src/index.ts" })).toBe(true);
    expect(condition.matches("Edit", { file_path: "README.md" })).toBe(false);
  });

  it("matches all arguments for a wildcard", () => {
    expect(new HookCondition("Read(*)").matches("Read", {})).toBe(true);
    expect(new HookCondition("Read()").matches("Read", { path: "a.txt" })).toBe(true);
  });

  it("rejects empty, malformed, nested, and oversized conditions", () => {
    expect(() => new HookCondition("")).toThrow(HookMatcherError);
    expect(() => new HookCondition("Bash")).toThrow("Tool(pattern)");
    expect(() => new HookCondition("Bash(git (*))")).toThrow("Tool(pattern)");
    expect(() => new HookCondition(`Bash(${"x".repeat(2_050)})`)).toThrow("exceeds 2048");
  });
});
