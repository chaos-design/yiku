import { clampCursorIndex } from "./prompt-preview.js";

export interface VerticalCursorMovement {
  readonly cursorIndex: number;
  readonly preferredColumn: number;
}

type CursorDirection = "down" | "up";
type CharacterKind = "punctuation" | "space" | "word";

interface LinePosition {
  readonly column: number;
  readonly end: number;
  readonly index: number;
  readonly lines: readonly LineRange[];
  readonly start: number;
}

interface LineRange {
  readonly end: number;
  readonly start: number;
}

export function moveCursorVertically(
  input: string,
  cursorIndex: number,
  direction: CursorDirection,
  preferredColumn?: number,
): VerticalCursorMovement {
  const position = locateCursor(input, cursorIndex);
  const targetColumn = preferredColumn ?? position.column;
  const targetLine = position.lines[position.index + (direction === "up" ? -1 : 1)];

  if (targetLine !== undefined) {
    return {
      cursorIndex: targetLine.start + Math.min(targetColumn, targetLine.end - targetLine.start),
      preferredColumn: targetColumn,
    };
  }

  return {
    cursorIndex: direction === "up" ? 0 : input.length,
    preferredColumn: targetColumn,
  };
}

export function moveCursorByWord(
  input: string,
  cursorIndex: number,
  direction: "left" | "right",
): number {
  return direction === "left"
    ? moveCursorToPreviousWord(input, cursorIndex)
    : moveCursorToNextWord(input, cursorIndex);
}

export function moveCursorToLineBoundary(
  input: string,
  cursorIndex: number,
  boundary: "end" | "start",
): number {
  const position = locateCursor(input, cursorIndex);

  return boundary === "start" ? position.start : position.end;
}

function locateCursor(input: string, cursorIndex: number): LinePosition {
  const resolvedCursorIndex = clampCursorIndex(cursorIndex, input);
  const lines = getLineRanges(input);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line !== undefined && resolvedCursorIndex <= line.end) {
      return {
        column: resolvedCursorIndex - line.start,
        end: line.end,
        index,
        lines,
        start: line.start,
      };
    }
  }

  const index = lines.length - 1;
  const line = lines[index] ?? { end: 0, start: 0 };

  return {
    column: line.end - line.start,
    end: line.end,
    index,
    lines,
    start: line.start,
  };
}

function getLineRanges(input: string): readonly LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;

  for (let index = 0; index <= input.length; index += 1) {
    if (index === input.length || input[index] === "\n") {
      ranges.push({ end: index, start });
      start = index + 1;
    }
  }

  return ranges;
}

function moveCursorToPreviousWord(input: string, cursorIndex: number): number {
  let index = clampCursorIndex(cursorIndex, input);

  while (index > 0 && previousCharacter(input, index).kind === "space") {
    index = previousCharacter(input, index).index;
  }

  if (index === 0) {
    return 0;
  }

  const kind = previousCharacter(input, index).kind;

  while (index > 0) {
    const previous = previousCharacter(input, index);

    if (previous.kind !== kind) {
      break;
    }

    index = previous.index;
  }

  return index;
}

function moveCursorToNextWord(input: string, cursorIndex: number): number {
  let index = clampCursorIndex(cursorIndex, input);

  if (index < input.length && nextCharacter(input, index).kind !== "space") {
    const kind = nextCharacter(input, index).kind;

    while (index < input.length) {
      const next = nextCharacter(input, index);

      if (next.kind !== kind) {
        break;
      }

      index = next.index;
    }
  }

  while (index < input.length && nextCharacter(input, index).kind === "space") {
    index = nextCharacter(input, index).index;
  }

  return index;
}

function previousCharacter(
  input: string,
  cursorIndex: number,
): { readonly index: number; readonly kind: CharacterKind } {
  let index = Math.max(0, cursorIndex - 1);

  if (isLowSurrogate(input.charCodeAt(index)) && isHighSurrogate(input.charCodeAt(index - 1))) {
    index -= 1;
  }

  return {
    index,
    kind: classifyCharacter(input.slice(index, cursorIndex)),
  };
}

function nextCharacter(
  input: string,
  cursorIndex: number,
): { readonly index: number; readonly kind: CharacterKind } {
  const codePoint = input.codePointAt(cursorIndex);
  const length = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  const nextIndex = Math.min(input.length, cursorIndex + length);

  return {
    index: nextIndex,
    kind: classifyCharacter(input.slice(cursorIndex, nextIndex)),
  };
}

function classifyCharacter(character: string): CharacterKind {
  if (/\s/u.test(character)) {
    return "space";
  }

  if (/[\p{L}\p{N}_]/u.test(character)) {
    return "word";
  }

  return "punctuation";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
