import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * PromptInput
 *
 * A terminal-style prompt input with an "l window": only the region around
 * the cursor is rendered so long inputs stay visible.
 *
 *   - Single-line output is byte-identical `> …█` when empty, `> <text>█`
 *     otherwise (no ellipsis unless truncated by the l-window).
 *   - Multi-line output is a column of rows: first row prefixed `> `,
 *     continuation rows prefixed `  `.
 *   - Ctrl+J inserts a newline.
 *   - Enter with a literal trailing backslash immediately before the cursor
 *     consumes that backslash and inserts a newline (continuation).
 *   - Plain Enter submits the current buffer (onSubmit).
 *
 * The "l window" (viewport) shows a limited number of context rows above and
 * below the cursor row, and a limited number of context columns around the
 * cursor column on the cursor's row, so the cursor always stays in view and
 * very long lines don't blow up the layout.
 */

export interface PromptInputProps {
  /** Initial value (uncontrolled; uncontrolled only for simplicity). */
  defaultValue?: string;
  /** Controlled value. */
  value?: string;
  /** Fires on plain Enter (after trimming a trailing \r if any). */
  onSubmit?: (value: string) => void;
  /** Fires on every edit. */
  onChange?: (value: string) => void;
  /** Placeholder shown only while buffer is empty. */
  placeholder?: string;
  /** Max number of context rows shown above the cursor row. */
  contextRowsAbove?: number;
  /** Max number of context rows shown below the cursor row. */
  contextRowsBelow?: number;
  /** Max number of columns shown to the left of the cursor on its row. */
  contextColsLeft?: number;
  /** Max number of columns shown to the right of the cursor on its row. */
  contextColsRight?: number;
  /** Extra class on the root <pre>. */
  className?: string;
  /** When true, ignore input (e.g. after submit until reset). */
  disabled?: boolean;
  /** Whether to auto-focus on mount. */
  autoFocus?: boolean;
  /**
   * Cursor style:
   *   - "block": solid filled block (█) — classic terminal.
   *   - "line":  thin vertical bar (the "line block" caret common in editors).
   */
  cursor?: "block" | "line";
}

interface Cursor {
  row: number;
  col: number;
}

// The block cursor character, and the horizontal ellipsis used to mark a
// truncated side of the cursor row in the l-window.
const CURSOR = "█";
const HELLIPSIS = "…";
const VELLIPSIS = "…";
const PROMPT = "> ";
const CONTINUATION = "  ";

/** Split a string into rows on \n, treating \r\n as a single newline too. */
function splitRows(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** Join rows back into a single string (we always store \n internally). */
function joinRows(rows: string[]): string {
  return rows.join("\n");
}

/** Clamp n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function PromptInput({
  defaultValue = "",
  value,
  onSubmit,
  onChange,
  placeholder,
  contextRowsAbove = 6,
  contextRowsBelow = 3,
  contextColsLeft = 40,
  contextColsRight = 20,
  className = "",
  disabled = false,
  autoFocus = true,
}: PromptInputProps) {
  const isControlled = value !== undefined;

  const [internalValue, setInternalValue] = useState<string>(defaultValue);
  const buffer = isControlled ? (value as string) : internalValue;

  const [cursor, setCursor] = useState<Cursor>(() => {
    const rows = splitRows(defaultValue);
    return { row: rows.length - 1, col: rows[rows.length - 1]?.length ?? 0 };
  });

  // Synchronize cursor when a controlled value changes wholesale (e.g. reset
  // after submit): move it to the end of the buffer.
  useEffect(() => {
    if (isControlled) {
      const rows = splitRows(value as string);
      setCursor({ row: rows.length - 1, col: rows[rows.length - 1]?.length ?? 0 });
    }
  }, [value, isControlled]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<boolean>(autoFocus);

  const rows = useMemo(() => splitRows(buffer), [buffer]);

  const commit = useCallback(
    (nextRows: string[], nextCursor: Cursor) => {
      const next = joinRows(nextRows);
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
      setCursor(nextCursor);
    },
    [isControlled, onChange],
  );

  // -------------------- Editing primitives --------------------

  const insertTextAtCursor = useCallback(
    (text: string) => {
      const rs = rows.slice();
      const line = rs[cursor.row] ?? "";
      const before = line.slice(0, cursor.col);
      const after = line.slice(cursor.col);
      // Text may contain newlines; split it and splice rows.
      const pieces = splitRows(text);
      if (pieces.length === 1) {
        rs[cursor.row] = before + pieces[0] + after;
        commit(rs, { row: cursor.row, col: cursor.col + pieces[0].length });
      } else {
        const first = before + pieces[0];
        const last = pieces[pieces.length - 1] + after;
        const middle = pieces.slice(1, pieces.length - 1);
        rs.splice(cursor.row, 1, first, ...middle, last);
        const newRow = cursor.row + pieces.length - 1;
        const newCol = pieces[pieces.length - 1].length;
        commit(rs, { row: newRow, col: newCol });
      }
    },
    [rows, cursor, commit],
  );

  const deleteBackwards = useCallback(() => {
    if (cursor.col === 0) {
      if (cursor.row === 0) return; // at very start, nothing to delete
      // Merge with previous row.
      const rs = rows.slice();
      const prev = rs[cursor.row - 1];
      const cur = rs[cursor.row];
      const newCol = prev.length;
      rs[cursor.row - 1] = prev + cur;
      rs.splice(cursor.row, 1);
      commit(rs, { row: cursor.row - 1, col: newCol });
    } else {
      const rs = rows.slice();
      const line = rs[cursor.row];
      rs[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
      commit(rs, { row: cursor.row, col: cursor.col - 1 });
    }
  }, [rows, cursor, commit]);

  const deleteForwards = useCallback(() => {
    const line = rows[cursor.row] ?? "";
    if (cursor.col === line.length) {
      if (cursor.row === rows.length - 1) return;
      const rs = rows.slice();
      rs[cursor.row] = line + rs[cursor.row + 1];
      rs.splice(cursor.row + 1, 1);
      commit(rs, { row: cursor.row, col: cursor.col });
    } else {
      const rs = rows.slice();
      rs[cursor.row] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
      commit(rs, cursor);
    }
  }, [rows, cursor, commit]);

  const insertNewline = useCallback(
    (consumeTrailingBackslash: boolean) => {
      const rs = rows.slice();
      let line = rs[cursor.row] ?? "";
      let col = cursor.col;
      if (consumeTrailingBackslash && col > 0 && line[col - 1] === "\\") {
        // Remove the trailing backslash, then break the line.
        line = line.slice(0, col - 1) + line.slice(col);
        col = col - 1;
        rs[cursor.row] = line;
      }
      const before = line.slice(0, col);
      const after = line.slice(col);
      rs.splice(cursor.row, 1, before, after);
      commit(rs, { row: cursor.row + 1, col: 0 });
    },
    [rows, cursor, commit],
  );

  const move = useCallback(
    (dr: number, dc: number) => {
      let { row, col } = cursor;
      if (dr !== 0) {
        row = clamp(row + dr, 0, rows.length - 1);
        col = clamp(col, 0, rows[row].length);
      }
      if (dc !== 0) {
        const line = rows[row] ?? "";
        col = col + dc;
        if (col < 0) {
          if (row === 0) {
            col = 0;
          } else {
            row -= 1;
            col = rows[row].length;
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
      setCursor({ row, col });
    },
    [cursor, rows],
  );

  const doSubmit = useCallback(() => {
    if (!onSubmit) return;
    onSubmit(buffer);
    // Reset buffer after submit if uncontrolled.
    if (!isControlled) {
      setInternalValue("");
      setCursor({ row: 0, col: 0 });
    }
  }, [buffer, onSubmit, isControlled]);

  // -------------------- Keyboard handling --------------------

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      // Ctrl+J: insert newline (classic terminal binding, since Enter is \r
      // and Ctrl+J is ASCII LF).
      if (e.key === "j" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        insertNewline(false);
        return;
      }

      // Enter: submit, unless there is a trailing backslash right before the
      // cursor (backslash-newline continuation), in which case consume it
      // and insert a real newline.
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const line = rows[cursor.row] ?? "";
        if (cursor.col > 0 && line[cursor.col - 1] === "\\") {
          insertNewline(true);
        } else {
          doSubmit();
        }
        return;
      }

      // Standard editing keys.
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          move(0, -1);
          return;
        case "ArrowRight":
          e.preventDefault();
          move(0, 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1, 0);
          return;
        case "ArrowDown":
          e.preventDefault();
          move(1, 0);
          return;
        case "Home":
          e.preventDefault();
          setCursor({ row: cursor.row, col: 0 });
          return;
        case "End":
          e.preventDefault();
          setCursor({ row: cursor.row, col: (rows[cursor.row] ?? "").length });
          return;
        case "Backspace":
          e.preventDefault();
          deleteBackwards();
          return;
        case "Delete":
          e.preventDefault();
          deleteForwards();
          return;
        default:
          // Let printable characters through; we capture them via the
          // beforeinput/keypress/textInput fallback in onInput below.
          break;
      }
    },
    [disabled, rows, cursor, insertNewline, doSubmit, move, deleteBackwards, deleteForwards],
  );

  // beforeinput / input events give us the most reliable stream of text
  // edits from IMEs, paste, compose, etc.
  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const ev = e.nativeEvent as InputEvent;
      if (disabled) return;
      // We always preventDefault on the contenteditable mutation because we
      // own the DOM; we apply the edit ourselves through our model.
      ev.preventDefault?.();
      switch (ev.inputType) {
        case "insertText":
        case "insertCompositionText":
        case "insertFromPaste":
        case "insertFromDrop":
        case "insertReplacementText":
          if (typeof ev.data === "string") insertTextAtCursor(ev.data);
          break;
        case "insertLineBreak":
        case "insertParagraph":
          insertNewline(false);
          break;
        case "deleteContentBackward":
          deleteBackwards();
          break;
        case "deleteContentForward":
          deleteForwards();
          break;
        default:
          // Unknown: ignore, don't mutate DOM.
          break;
      }
    },
    [disabled, insertTextAtCursor, insertNewline, deleteBackwards, deleteForwards],
  );

  // Keep the contenteditable DOM from drifting (we never let the browser
  // mutate it directly) by always resetting its text content to "" on mount.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // We don't render actual text into the contenteditable; we render our own
    // visual representation as a sibling overlay. The contenteditable itself
    // stays empty and only acts as a focus/keyboard trap.
    el.textContent = "";
  }, []);

  // -------------------- L-window rendering --------------------

  /**
   * Compute which rows and which slice of the cursor row to render.
   *
   * The viewport is an L-shape:
   *   - vertically: rows [cursorRow - above, cursorRow + below], clamped
   *   - horizontally on the cursor row: columns [col - left, col + right]
   *   - non-cursor rows are rendered in full (they're already bounded by
   *     the vertical window and typically short because the cursor is nearby)
   */
  const rendered = useMemo(() => {
    const nRows = rows.length;
    const cRow = clamp(cursor.row, 0, nRows - 1);
    const startRow = Math.max(0, cRow - contextRowsAbove);
    const endRow = Math.min(nRows - 1, cRow + contextRowsBelow);

    const line = rows[cRow] ?? "";
    const cCol = clamp(cursor.col, 0, line.length);
    const colStart = Math.max(0, cCol - contextColsLeft);
    const colEnd = Math.min(line.length, cCol + contextColsRight);

    const viewRows: {
      index: number;
      prefix: string;
      beforeCursor: string;
      afterCursor: string;
      truncatedLeft: boolean;
      truncatedRight: boolean;
      isCursorRow: boolean;
    }[] = [];

    for (let r = startRow; r <= endRow; r++) {
      const isCur = r === cRow;
      const prefix = r === 0 ? PROMPT : CONTINUATION;
      const l = rows[r] ?? "";
      let beforeCursor: string;
      let afterCursor: string;
      let truncatedLeft = false;
      let truncatedRight = false;
      if (isCur) {
        const cs = colStart;
        const ce = colEnd;
        truncatedLeft = cs > 0;
        truncatedRight = ce < l.length;
        beforeCursor = (truncatedLeft ? HELLIPSIS : "") + l.slice(cs, cCol);
        afterCursor = l.slice(cCol, ce) + (truncatedRight ? HELLIPSIS : "");
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

    const showTopEllipsis = startRow > 0;
    const showBottomEllipsis = endRow < nRows - 1;

    return { viewRows, showTopEllipsis, showBottomEllipsis };
  }, [rows, cursor, contextRowsAbove, contextRowsBelow, contextColsLeft, contextColsRight]);

  // -------------------- Output --------------------

  const isEmpty = buffer.length === 0;
  const showPlaceholder = isEmpty && !focused && placeholder;

  // Empty single-line form is the byte-exact string "> …█" (the … stands in
  // for "empty input here"). As soon as the user types, we switch to the
  // generic row renderer which also handles the single-line case as a single
  // row, preserving "> <text>█" output with optional truncation ellipses.
  const showEmptyForm = isEmpty && !showPlaceholder;

  return (
    <div
      className={
        "relative inline-block min-w-0 font-mono text-sm whitespace-pre-wrap break-words " +
        "text-left " +
        className
      }
    >
      {/* Hidden but focusable input trap. We don't actually render text into
          it; we intercept beforeinput/keydown and render our own visual. */}
      {/* biome-ignore lint/a11y/useSemanticElements: contentEditable is used as an input trap for a custom rendered multi-line prompt. */}
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder ?? "Prompt input"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onBeforeInput={onBeforeInput}
        onInput={(e) => {
          // Always discard any DOM mutation that sneaks through.
          const el = e.currentTarget;
          if (el.textContent !== "") el.textContent = "";
        }}
        onPaste={(e) => {
          // Paste is handled via beforeinput; drop the default.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) insertTextAtCursor(text);
        }}
        className="absolute inset-0 z-10 h-full w-full cursor-text caret-transparent outline-none"
      />
      {/* Visual overlay. */}
      <pre aria-hidden className="m-0 whitespace-pre-wrap break-words font-mono text-inherit">
        {rendered.showTopEllipsis ? <div>{VELLIPSIS}</div> : null}
        {showEmptyForm ? (
          <div>
            <span>{PROMPT}</span>
            <span>{HELLIPSIS}</span>
            <span className={focused ? "" : "opacity-60"}>{CURSOR}</span>
          </div>
        ) : showPlaceholder ? (
          <div>
            <span>{PROMPT}</span>
            <span className="text-muted-foreground/70">{placeholder}</span>
            <span className="opacity-60">{CURSOR}</span>
          </div>
        ) : (
          rendered.viewRows.map((vr) => (
            <div key={vr.index}>
              <span className="text-muted-foreground">{vr.prefix}</span>
              {vr.truncatedLeft ? <span>{HELLIPSIS}</span> : null}
              <span>{vr.beforeCursor}</span>
              <span
                className={
                  "inline-block min-w-[1ch] " +
                  (focused ? "bg-foreground text-background" : "text-muted-foreground")
                }
              >
                {CURSOR}
              </span>
              <span>{vr.afterCursor}</span>
              {vr.truncatedRight ? <span>{HELLIPSIS}</span> : null}
            </div>
          ))
        )}
        {rendered.showBottomEllipsis ? <div>{VELLIPSIS}</div> : null}
      </pre>
    </div>
  );
}

export default PromptInput;
