import { describe, expect, it } from "vitest";
import {
  applyFileCompletion,
  type FileCompletionQuery,
  getFileCompletionQuery,
  getShellCommandQuery,
} from "../../src/app/completion.js";

function requireCompletion(input: string, cursorIndex: number): FileCompletionQuery {
  const completion = getFileCompletionQuery(input, cursorIndex);

  if (!completion) {
    throw new Error(`Expected a completion query for "${input}"`);
  }

  return completion;
}

describe("getShellCommandQuery", () => {
  it("detects a leading ! as a shell command", () => {
    expect(getShellCommandQuery("!ls -la")).toEqual({ command: "ls -la", startIndex: 0 });
  });

  it("ignores leading whitespace before the ! prefix", () => {
    expect(getShellCommandQuery("  !pwd")).toEqual({ command: "pwd", startIndex: 2 });
  });

  it("returns an empty command for a bare ! prefix", () => {
    expect(getShellCommandQuery("!")).toEqual({ command: "", startIndex: 0 });
  });

  it("ignores input that does not start with !", () => {
    expect(getShellCommandQuery("ls -la")).toBeUndefined();
    expect(getShellCommandQuery("echo ! done")).toBeUndefined();
    expect(getShellCommandQuery("")).toBeUndefined();
    expect(getShellCommandQuery("   ")).toBeUndefined();
  });
});

describe("getFileCompletionQuery", () => {
  it("detects an @ query at the cursor", () => {
    expect(getFileCompletionQuery("@pack", 5)).toEqual({
      endIndex: 5,
      query: "pack",
      startIndex: 0,
    });
  });

  it("detects an @ query following whitespace", () => {
    expect(getFileCompletionQuery("show @src/ap", 12)).toEqual({
      endIndex: 12,
      query: "src/ap",
      startIndex: 5,
    });
  });

  it("ignores @ that is attached to a previous word", () => {
    expect(getFileCompletionQuery("email@example", 13)).toBeUndefined();
  });

  it("ignores a query that contains whitespace after the @", () => {
    expect(getFileCompletionQuery("@src file", 9)).toBeUndefined();
  });

  it("returns undefined when there is no @ before the cursor", () => {
    expect(getFileCompletionQuery("plain text", 5)).toBeUndefined();
  });
});

describe("applyFileCompletion", () => {
  it("inserts a file entry and appends a trailing space", () => {
    const completion = requireCompletion("@pack", 5);

    expect(applyFileCompletion("@pack", completion, "package.json")).toEqual({
      cursorIndex: 14,
      value: "@package.json ",
    });
  });

  it("keeps the cursor inside a directory entry without a trailing space", () => {
    const completion = requireCompletion("@pack", 5);

    expect(applyFileCompletion("@pack", completion, "packages/")).toEqual({
      cursorIndex: 10,
      value: "@packages/",
    });
  });

  it("preserves text that follows the completed token", () => {
    const completion = requireCompletion("use @src rest", 8);

    expect(applyFileCompletion("use @src rest", completion, "src/main.ts")).toEqual({
      cursorIndex: 17,
      value: "use @src/main.ts  rest",
    });
  });
});
