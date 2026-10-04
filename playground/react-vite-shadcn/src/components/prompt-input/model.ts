/**
 * Pure model for the multi-line prompt buffer.
 *
 * This module knows nothing about React or the DOM. It exposes:
 *
 *  - A `Cursor` type (row/col, zero-based; col is a UTF-16 code-unit offset
 *    on the given row — same convention the DOM uses for selections, and good
 *    enough for our ASCII/unicode-mixture use case).
 *  - `splitRows` / `joinRows` helpers for normalizing newlines.
 *  - Pure editing primitives (`insertText`, `deleteBackward`, `deleteForward`,
 *    `insertNewline`, `moveCursor`, `clampCursor`) that take a `(buffer, cursor)`
 *    pair and return a new `(buffer, cursor)` pair.
 *
 * The React component thin-wraps these primitives without coupling the model
 * to a React environment.
 */

import { CONTINUATION, CURSOR, HELLIPSIS, PROMPT, VELLIPSIS } from "./constants";

export interface Cursor {
  readonly row: number;
  readonly col: number;
}

export interface ViewWindow {
  readonly rowsAbove: number;
  readonly rowsBelow: number;
  readonly colsLeft: number;
  readonly colsRight: number;
}

export interface ViewRow {
  /** Original row index (0-based) into the full buffer's rows. */
  readonly index: number;
  /** The prompt prefix to render before this row's text. */
  readonly prefix: string;
  /** Text on this row strictly before the cursor (possibly with a leading H_ELLIPSIS). */
  readonly beforeCursor: string;
  /** Text on this row strictly after the cursor (possibly with a trailing H_ELLIPSIS). */
  readonly afterCursor: string;
  readonly truncatedLeft: boolean;
  readonly truncatedRight: boolean;
  readonly isCursorRow: boolean;
}

export interface ViewRendering {
  readonly viewRows: readonly ViewRow[];
  readonly showTopEllipsis: boolean;
  readonly showBottomEllipsis: boolean;
  readonly isEmpty: boolean;
}

/**
 * Normalize a raw string into rows. Treats CRLF and lone CR as LF.
 */
export function splitRows(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** Join rows back together with LF. */
export function joinRows(rows: readonly string[]): string {
  return rows.join("\n");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Return a cursor that is guaranteed to lie within the given buffer. */
export function clampCursor(buffer: string, cursor: Cursor): Cursor {
  const rows = splitRows(buffer);
  const row = clamp(cursor.row, 0, Math.max(0, rows.length - 1));
  const col = clamp(cursor.col, 0, rows[row]?.length ?? 0);
  return { row, col };
}

/**
 * Return the end-of-buffer cursor (useful after resetting to a new value).
 */
export function endCursor(buffer: string): Cursor {
  const rows = splitRows(buffer);
  const row = Math.max(0, rows.length - 1);
  return { row, col: rows[row]?.length ?? 0 };
}

export interface EditResult {
  readonly buffer: string;
  readonly cursor: Cursor;
}

function commit(rows: string[], cursor: Cursor): EditResult {
  return { buffer: joinRows(rows), cursor };
}

/** Insert arbitrary text (which may contain newlines) at the cursor. */
export function insertText(buffer: string, cursor: Cursor, text: string): EditResult {
  const rows = splitRows(buffer);
  const c = clampCursor(buffer, cursor);
  const line = rows[c.row] ?? "";
  const before = line.slice(0, c.col);
  const after = line.slice(c.col);
  const pieces = splitRows(text);
  if (pieces.length === 1) {
    rows[c.row] = before + pieces[0] + after;
    return commit(rows, { row: c.row, col: c.col + pieces[0].length });
  }
  const first = before + pieces[0];
  const last = pieces[pieces.length - 1] + after;
  const middle = pieces.slice(1, pieces.length - 1);
  rows.splice(c.row, 1, first, ...middle, last);
  const newRow = c.row + pieces.length - 1;
  const newCol = pieces[pieces.length - 1].length;
  return commit(rows, { row: newRow, col: newCol });
}

/** Delete one character (or merge a line) backward from the cursor. */
export function deleteBackward(buffer: string, cursor: Cursor): EditResult {
  const rows = splitRows(buffer);
  const c = clampCursor(buffer, cursor);
  if (c.col === 0) {
    if (c.row === 0) return { buffer, cursor: c };
    const prev = rows[c.row - 1];
    const cur = rows[c.row];
    const newCol = prev.length;
    rows[c.row - 1] = prev + cur;
    rows.splice(c.row, 1);
    return commit(rows, { row: c.row - 1, col: newCol });
  }
  const line = rows[c.row];
  rows[c.row] = line.slice(0, c.col - 1) + line.slice(c.col);
  return commit(rows, { row: c.row, col: c.col - 1 });
}

/** Delete one character (or merge a line) forward from the cursor. */
export function deleteForward(buffer: string, cursor: Cursor): EditResult {
  const rows = splitRows(buffer);
  const c = clampCursor(buffer, cursor);
  const line = rows[c.row] ?? "";
  if (c.col === line.length) {
    if (c.row === rows.length - 1) return { buffer, cursor: c };
    rows[c.row] = line + rows[c.row + 1];
    rows.splice(c.row + 1, 1);
    return commit(rows, { row: c.row, col: c.col });
  }
  rows[c.row] = line.slice(0, c.col) + line.slice(c.col + 1);
  return commit(rows, c);
}

/**
 * Insert a newline at the cursor. If `consumeTrailingBackslash` is true and
 * the character immediately before the cursor is `\`, that backslash is
 * removed before the break (shell-style line continuation).
 */
export function insertNewline(
  buffer: string,
  cursor: Cursor,
  consumeTrailingBackslash = false,
): EditResult {
  const rows = splitRows(buffer);
  const c = clampCursor(buffer, cursor);
  let line = rows[c.row] ?? "";
  let col = c.col;
  if (consumeTrailingBackslash && col > 0 && line[col - 1] === "\\") {
    line = line.slice(0, col - 1) + line.slice(col);
    col -= 1;
    rows[c.row] = line;
  }
  const before = line.slice(0, col);
  const after = line.slice(col);
  rows.splice(c.row, 1, before, after);
  return commit(rows, { row: c.row + 1, col: 0 });
}

export function moveCursor(buffer: string, cursor: Cursor, dr: number, dc: number): Cursor {
  const rows = splitRows(buffer);
  let { row, col } = clampCursor(buffer, cursor);
  if (dr !== 0) {
    row = clamp(row + dr, 0, Math.max(0, rows.length - 1));
    col = clamp(col, 0, rows[row]?.length ?? 0);
  }
  if (dc !== 0) {
    const line = rows[row] ?? "";
    col += dc;
    if (col < 0) {
      if (row === 0) {
        col = 0;
      } else {
        row -= 1;
        col = rows[row]?.length ?? 0;
      }
    } else if (col > line.length) {
      if (row === rows.length - 1) {
        col = line.length;
      } else {
        row += 1;
        col = 0;
      }
    }
  }
  return { row, col };
}

/**
 * Compute the l-window view rendering for the given buffer + cursor.
 *
 * This is what the React component, server-side rendering, or terminal
 * preview surfaces use to know what to draw.
 */
export function renderView(buffer: string, cursor: Cursor, win: ViewWindow): ViewRendering {
  const rows = splitRows(buffer);
  const nRows = rows.length;
  const c = clampCursor(buffer, cursor);

  const startRow = Math.max(0, c.row - win.rowsAbove);
  const endRow = Math.min(Math.max(0, nRows - 1), c.row + win.rowsBelow);

  const line = rows[c.row] ?? "";
  const cCol = clamp(c.col, 0, line.length);
  const colStart = Math.max(0, cCol - win.colsLeft);
  const colEnd = Math.min(line.length, cCol + win.colsRight);

  const viewRows: ViewRow[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const isCur = r === c.row;
    const prefix = r === 0 ? PROMPT : CONTINUATION;
    const l = rows[r] ?? "";
    let beforeCursor = "";
    let afterCursor = "";
    let truncatedLeft = false;
    let truncatedRight = false;
    if (isCur) {
      truncatedLeft = colStart > 0;
      truncatedRight = colEnd < l.length;
      beforeCursor = (truncatedLeft ? HELLIPSIS : "") + l.slice(colStart, cCol);
      afterCursor = l.slice(cCol, colEnd) + (truncatedRight ? HELLIPSIS : "");
    } else {
      beforeCursor = l;
      afterCursor = "";
    }
    viewRows.push({
      index: r,
      prefix,
      beforeCursor,
      afterCursor,
      truncatedLeft,
      truncatedRight,
      isCursorRow: isCur,
    });
  }

  return {
    viewRows,
    showTopEllipsis: startRow > 0,
    showBottomEllipsis: endRow < nRows - 1,
    isEmpty: buffer.length === 0,
  };
}

/**
 * Render a single view row into a flat string, with the cursor position
 * marked by {@link CURSOR}. Useful for preview and debugging surfaces.
 */
export function renderRowToString(vr: ViewRow): string {
  const parts: string[] = [];
  parts.push(vr.prefix);
  if (vr.truncatedLeft) parts.push(HELLIPSIS);
  parts.push(vr.beforeCursor);
  parts.push(CURSOR);
  parts.push(vr.afterCursor);
  if (vr.truncatedRight) parts.push(HELLIPSIS);
  return parts.join("");
}

/**
 * Render the full view (including top/bottom vertical ellipses) into an
 * array of lines. The cursor is marked by {@link CURSOR} on its row; other
 * rows contain no cursor marker since the cursor isn't there.
 *
 * For the empty-buffer case the renderer emits the canonical single-line
 * prompt `> …█` (the ellipsis is intentional — it stands in for "empty
 * input area" in the l-window view).
 */
export function renderViewToString(buffer: string, cursor: Cursor, win: ViewWindow): string[] {
  const v = renderView(buffer, cursor, win);
  const out: string[] = [];
  if (v.showTopEllipsis) out.push(VELLIPSIS);
  if (v.isEmpty && !v.showTopEllipsis && !v.showBottomEllipsis) {
    out.push(PROMPT + HELLIPSIS + CURSOR);
    return out;
  }
  for (const vr of v.viewRows) {
    if (vr.isCursorRow) {
      out.push(renderRowToString(vr));
    } else {
      out.push(
        vr.prefix +
          (vr.truncatedLeft ? HELLIPSIS : "") +
          vr.beforeCursor +
          (vr.truncatedRight ? HELLIPSIS : ""),
      );
    }
  }
  if (v.showBottomEllipsis) out.push(VELLIPSIS);
  return out;
}
