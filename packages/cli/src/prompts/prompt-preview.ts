import {
  MAX_PROMPT_PREVIEW_LENGTH,
  PROMPT_CURSOR,
  PROMPT_MAX_VISIBLE_ROWS,
  PROMPT_PLACEHOLDER,
} from "./constants.js";

export interface PromptPreview {
  readonly after: string;
  readonly before: string;
  readonly cursor: string;
  readonly placeholder?: boolean;
}

export interface PromptRow {
  readonly after: string;
  readonly before: string;
  readonly cursor: string;
  readonly isCursorRow: boolean;
  readonly lineIndex: number;
  readonly placeholder?: boolean;
}

export interface PromptRowsResult {
  readonly hasAbove: boolean;
  readonly hasBelow: boolean;
  readonly rows: readonly PromptRow[];
}

interface LineSegments {
  readonly after: string;
  readonly before: string;
  readonly cursor: string;
}

export function hasLineBreak(input: string): boolean {
  return input.includes("\n") || input.includes("\r");
}

export function isLineContinuation(input: string, cursorIndex: number): boolean {
  const resolvedCursorIndex = clampCursorIndex(cursorIndex, input);

  return resolvedCursorIndex > 0 && input[resolvedCursorIndex - 1] === "\\";
}

export function normalizeLineBreaks(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

export function getPromptPreview(prompt: string, cursorIndex: number): PromptPreview {
  const resolvedCursorIndex = clampCursorIndex(cursorIndex, prompt);

  if (!prompt) {
    return {
      after: PROMPT_PLACEHOLDER.slice(1),
      before: "",
      cursor: PROMPT_PLACEHOLDER.slice(0, 1),
      placeholder: true,
    };
  }

  return getLineCursorSegments(prompt, resolvedCursorIndex, MAX_PROMPT_PREVIEW_LENGTH);
}

export function getPromptRows(
  input: string,
  cursorIndex: number,
  maxVisibleRows: number = PROMPT_MAX_VISIBLE_ROWS,
  maxVisibleColumns: number = MAX_PROMPT_PREVIEW_LENGTH,
): PromptRowsResult {
  if (!input) {
    return {
      hasAbove: false,
      hasBelow: false,
      rows: [{ ...getPromptPreview("", 0), isCursorRow: true, lineIndex: 0 }],
    };
  }

  const resolvedCursorIndex = clampCursorIndex(cursorIndex, input);
  const lines = input.split("\n");
  const { column, lineIndex } = locateCursor(lines, resolvedCursorIndex);
  const allRows: PromptRow[] = lines.map((line, index) => {
    if (index === lineIndex) {
      return {
        ...getLineCursorSegments(line, column, maxVisibleColumns),
        isCursorRow: true,
        lineIndex: index,
      };
    }

    return {
      ...getLineDisplaySegments(line, maxVisibleColumns),
      isCursorRow: false,
      lineIndex: index,
    };
  });

  return windowRows(allRows, lineIndex, Math.max(1, maxVisibleRows));
}

export function insertTextAt(input: string, cursorIndex: number, text: string): string {
  const resolvedCursorIndex = clampCursorIndex(cursorIndex, input);

  return `${input.slice(0, resolvedCursorIndex)}${text}${input.slice(resolvedCursorIndex)}`;
}

export function clampCursorIndex(cursorIndex: number, input: string): number {
  return Math.min(Math.max(cursorIndex, 0), input.length);
}

function locateCursor(
  lines: readonly string[],
  cursorIndex: number,
): { column: number; lineIndex: number } {
  let remaining = cursorIndex;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineLength = lines[lineIndex]?.length ?? 0;

    if (remaining <= lineLength) {
      return { column: remaining, lineIndex };
    }

    remaining -= lineLength + 1;
  }

  const lastIndex = Math.max(0, lines.length - 1);

  return { column: lines[lastIndex]?.length ?? 0, lineIndex: lastIndex };
}

function windowRows(
  rows: readonly PromptRow[],
  cursorLineIndex: number,
  maxVisibleRows: number,
): PromptRowsResult {
  if (rows.length <= maxVisibleRows) {
    return { hasAbove: false, hasBelow: false, rows };
  }

  const start = Math.min(
    Math.max(0, cursorLineIndex - Math.floor(maxVisibleRows / 2)),
    rows.length - maxVisibleRows,
  );
  const end = start + maxVisibleRows;

  return {
    hasAbove: start > 0,
    hasBelow: end < rows.length,
    rows: rows.slice(start, end),
  };
}

function getLineDisplaySegments(line: string, maxVisibleColumns: number): LineSegments {
  const visibleColumns = Math.max(7, maxVisibleColumns);

  if (line.length <= visibleColumns) {
    return { after: "", before: line, cursor: "" };
  }

  return {
    after: "",
    before: `${line.slice(0, visibleColumns - 3)}...`,
    cursor: "",
  };
}

function getLineCursorSegments(
  line: string,
  cursorColumn: number,
  maxVisibleColumns: number,
): LineSegments {
  const resolvedColumn = Math.min(Math.max(cursorColumn, 0), line.length);
  const visibleColumns = Math.max(7, maxVisibleColumns);

  if (line.length <= visibleColumns) {
    if (resolvedColumn < line.length) {
      return {
        after: line.slice(resolvedColumn + 1),
        before: line.slice(0, resolvedColumn),
        cursor: line.slice(resolvedColumn, resolvedColumn + 1),
      };
    }

    return {
      after: line.slice(resolvedColumn),
      before: line.slice(0, resolvedColumn),
      cursor: PROMPT_CURSOR,
    };
  }

  const visibleInputLength = visibleColumns - 6;
  const visibleStart = Math.min(
    Math.max(0, resolvedColumn - Math.floor(visibleInputLength / 2)),
    Math.max(0, line.length - visibleInputLength),
  );
  const visibleEnd = Math.min(line.length, visibleStart + visibleInputLength);
  const visibleLine = line.slice(visibleStart, visibleEnd);
  const visibleCursorIndex = resolvedColumn - visibleStart;
  const cursorOffset = resolvedColumn < line.length ? 1 : 0;
  const cursorText =
    cursorOffset === 1 ? line.slice(resolvedColumn, resolvedColumn + 1) : PROMPT_CURSOR;

  return {
    after: `${visibleLine.slice(visibleCursorIndex + cursorOffset)}${visibleEnd < line.length ? "..." : ""}`,
    before: `${visibleStart > 0 ? "..." : ""}${visibleLine.slice(0, visibleCursorIndex)}`,
    cursor: cursorText,
  };
}
