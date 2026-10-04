import { describe, expect, it } from "vitest";
import {
  moveCursorByWord,
  moveCursorToLineBoundary,
  moveCursorVertically,
} from "../../src/prompts/index.js";

describe("moveCursorVertically", () => {
  it("preserves the preferred column across shorter lines", () => {
    const input = "abcd\nx\nwxyz";
    const firstMove = moveCursorVertically(input, input.length, "up");
    const secondMove = moveCursorVertically(
      input,
      firstMove.cursorIndex,
      "up",
      firstMove.preferredColumn,
    );
    const thirdMove = moveCursorVertically(
      input,
      secondMove.cursorIndex,
      "down",
      secondMove.preferredColumn,
    );
    const fourthMove = moveCursorVertically(
      input,
      thirdMove.cursorIndex,
      "down",
      thirdMove.preferredColumn,
    );

    expect(firstMove).toEqual({ cursorIndex: 6, preferredColumn: 4 });
    expect(secondMove).toEqual({ cursorIndex: 4, preferredColumn: 4 });
    expect(thirdMove).toEqual({ cursorIndex: 6, preferredColumn: 4 });
    expect(fourthMove).toEqual({ cursorIndex: input.length, preferredColumn: 4 });
  });

  it("moves to the whole-input boundary when no adjacent line exists", () => {
    expect(moveCursorVertically("single", 3, "up")).toEqual({
      cursorIndex: 0,
      preferredColumn: 3,
    });
    expect(moveCursorVertically("single", 3, "down")).toEqual({
      cursorIndex: 6,
      preferredColumn: 3,
    });
  });
});

describe("moveCursorByWord", () => {
  it("moves across words, whitespace, and punctuation groups", () => {
    const input = "alpha beta.gamma";

    expect(moveCursorByWord(input, input.length, "left")).toBe(11);
    expect(moveCursorByWord(input, 11, "left")).toBe(10);
    expect(moveCursorByWord(input, 10, "left")).toBe(6);
    expect(moveCursorByWord(input, 6, "left")).toBe(0);
    expect(moveCursorByWord(input, 0, "right")).toBe(6);
    expect(moveCursorByWord(input, 6, "right")).toBe(10);
    expect(moveCursorByWord(input, 10, "right")).toBe(11);
    expect(moveCursorByWord(input, 11, "right")).toBe(input.length);
  });

  it("treats Chinese text as word characters and preserves code point boundaries", () => {
    const input = "你好， world 😀 done";

    expect(moveCursorByWord(input, 0, "right")).toBe(2);
    expect(moveCursorByWord(input, 2, "right")).toBe(4);
    expect(moveCursorByWord(input, 3, "right")).toBe(4);
    expect(moveCursorByWord(input, input.length, "left")).toBe(13);
    expect(moveCursorByWord(input, 13, "left")).toBe(10);
  });
});

describe("moveCursorToLineBoundary", () => {
  it("moves to the current logical line start and end", () => {
    const input = "first\nsecond\nthird";

    expect(moveCursorToLineBoundary(input, 9, "start")).toBe(6);
    expect(moveCursorToLineBoundary(input, 9, "end")).toBe(12);
    expect(moveCursorToLineBoundary(input, input.length, "start")).toBe(13);
    expect(moveCursorToLineBoundary(input, input.length, "end")).toBe(input.length);
  });
});
