import { describe, expect, it } from "vitest";
import {
  getPromptPreview,
  getPromptRows,
  isLineContinuation,
  normalizeLineBreaks,
  PROMPT_CURSOR,
} from "../../src/prompts/index.js";

describe("normalizeLineBreaks", () => {
  it("normalizes CRLF and CR without changing LF", () => {
    expect(normalizeLineBreaks("one\r\ntwo\rthree\nfour")).toBe("one\ntwo\nthree\nfour");
  });
});

describe("isLineContinuation", () => {
  it("detects a trailing backslash before the cursor", () => {
    expect(isLineContinuation("first\\", 6)).toBe(true);
    expect(isLineContinuation("first\\second", 6)).toBe(true);
  });

  it("returns false when the character before the cursor is not a backslash", () => {
    expect(isLineContinuation("first", 5)).toBe(false);
    expect(isLineContinuation("first\\", 5)).toBe(false);
    expect(isLineContinuation("", 0)).toBe(false);
  });

  it("clamps the cursor index before inspecting the input", () => {
    expect(isLineContinuation("first\\", 999)).toBe(true);
    expect(isLineContinuation("first\\", -5)).toBe(false);
  });
});

describe("getPromptPreview", () => {
  it("renders the cursor over the first placeholder character for empty input", () => {
    expect(getPromptPreview("", 0)).toEqual({
      after: "sk anything...",
      before: "",
      cursor: "A",
      placeholder: true,
    });
  });

  it("renders the cursor on the current input character", () => {
    expect(getPromptPreview("abc", 1)).toEqual({
      after: "c",
      before: "a",
      cursor: "b",
    });
  });

  it("renders the prompt cursor at the end of the input", () => {
    expect(getPromptPreview("abc", 3)).toEqual({
      after: "",
      before: "abc",
      cursor: PROMPT_CURSOR,
    });
  });

  it("renders long input with the cursor at the visible start", () => {
    const preview = getPromptPreview("x".repeat(140), 0);

    expect(preview.before).toBe("");
    expect(preview.cursor).toBe("x");
    expect(preview.after).toMatch(/\.\.\.$/);
  });

  it("renders long input around a cursor inside the text", () => {
    const preview = getPromptPreview("x".repeat(140), 70);

    expect(preview.before).toMatch(/^\.\.\./);
    expect(preview.cursor).toBe("x");
    expect(preview.after).toMatch(/\.\.\.$/);
  });

  it("renders long input with the prompt cursor at the end", () => {
    const preview = getPromptPreview("x".repeat(140), 140);

    expect(preview.before).toMatch(/^\.\.\./);
    expect(preview.cursor).toBe(PROMPT_CURSOR);
    expect(preview.after).toBe("");
  });
});

describe("getPromptRows", () => {
  it("renders a single placeholder row for empty input", () => {
    const result = getPromptRows("", 0);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      after: "sk anything...",
      cursor: "A",
      isCursorRow: true,
      placeholder: true,
    });
    expect(result.hasAbove).toBe(false);
    expect(result.hasBelow).toBe(false);
  });

  it("splits input into rows and marks the cursor row", () => {
    const result = getPromptRows("first\nsecond", 8);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ before: "first", cursor: "", isCursorRow: false });
    expect(result.rows[1]).toMatchObject({ before: "se", cursor: "c", isCursorRow: true });
  });

  it("renders the block cursor at the end of a line", () => {
    const result = getPromptRows("ab\ncd", 5);

    expect(result.rows[1]).toMatchObject({
      before: "cd",
      cursor: PROMPT_CURSOR,
      isCursorRow: true,
    });
  });

  it("truncates long non-cursor lines", () => {
    const longLine = "y".repeat(140);
    const result = getPromptRows(`${longLine}\nz`, 142);

    expect(result.rows[0]?.before).toMatch(/\.\.\.$/);
    expect(result.rows[0]?.isCursorRow).toBe(false);
  });

  it("uses the caller-provided terminal width", () => {
    const result = getPromptRows("x".repeat(100), 50, 8, 20);
    const cursorRow = result.rows[0];

    expect(cursorRow?.before.startsWith("...")).toBe(true);
    expect(cursorRow?.after.endsWith("...")).toBe(true);
    expect(
      `${cursorRow?.before}${cursorRow?.cursor}${cursorRow?.after}`.length,
    ).toBeLessThanOrEqual(20);
  });

  it("windows rows around the cursor when exceeding the visible limit", () => {
    const input = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const cursorIndex = input.indexOf("line9");
    const result = getPromptRows(input, cursorIndex, 4);

    expect(result.rows).toHaveLength(4);
    expect(result.hasAbove).toBe(true);
    expect(result.hasBelow).toBe(false);
    expect(result.rows.at(-1)?.isCursorRow).toBe(true);
  });

  it("clamps the cursor to the last line when the index exceeds the input", () => {
    const result = getPromptRows("ab\ncd", 100);

    expect(result.rows[1]).toMatchObject({ isCursorRow: true, cursor: PROMPT_CURSOR });
  });

  it("keeps preceding line indices stable when windowing from the middle", () => {
    const input = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const cursorIndex = input.indexOf("line5");
    const result = getPromptRows(input, cursorIndex, 4);

    expect(result.hasAbove).toBe(true);
    expect(result.hasBelow).toBe(true);
    expect(result.rows.some((row) => row.lineIndex === 0)).toBe(false);
    expect(result.rows.find((row) => row.isCursorRow)?.lineIndex).toBe(5);
  });

  it("renders the block cursor on an empty trailing line", () => {
    const result = getPromptRows("ab\n", 3);

    expect(result.rows[1]).toMatchObject({
      before: "",
      cursor: PROMPT_CURSOR,
      isCursorRow: true,
    });
  });
});
