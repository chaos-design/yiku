/**
 * Constants used by the prompt-input model and renderer.
 *
 * These are kept as plain strings so the pure preview module can reuse
 * them without pulling in React.
 */

/** Block cursor drawn over the character at (or after, at EOL) the caret. */
export const CURSOR = "█";

/** Horizontal ellipsis — placed at the start/end of a truncated cursor row. */
export const HELLIPSIS = "…";

/** Vertical ellipsis — shown above/below the visible row window. */
export const VELLIPSIS = "…";

/** Prefix for the first (topmost) line of the prompt. */
export const PROMPT = "> ";

/** Prefix for continuation lines (lines 2..n). */
export const CONTINUATION = "  ";

/**
 * Default viewport (l-window) sizing. These control how much context is
 * visible around the cursor in each direction before truncation kicks in.
 */
export const DEFAULT_CONTEXT_ROWS_ABOVE = 6;
export const DEFAULT_CONTEXT_ROWS_BELOW = 3;
export const DEFAULT_CONTEXT_COLS_LEFT = 40;
export const DEFAULT_CONTEXT_COLS_RIGHT = 20;
