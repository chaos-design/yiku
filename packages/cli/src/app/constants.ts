export const DEFAULT_MODEL_LABEL = "model resolving";
export const DEFAULT_WORKSPACE_LABEL = process.env.YIKU_WORKSPACE_DIR ?? process.cwd();
export const FILE_COMPLETION_LIMIT = 8;
export const FILE_SEARCH_SCAN_LIMIT = 5_000;
export const SLASH_COMMAND_MENU_MAX_VISIBLE_ROWS = 12;
export const LAYOUT_SPACING = {
  compact: 0.1,
  header: 0.4,
  item: 1,
  live: 0.3,
  prompt: 0.2,
} as const;
export const TOOL_DETAIL_PREFIX = "  ";
export const TOOL_RESULT_PREFIX = "└ ";
export const YIKU_LOGO = [
  "██╗   ██╗██╗██╗  ██╗██╗   ██╗",
  "╚██╗ ██╔╝██║██║ ██╔╝██║   ██║",
  " ╚████╔╝ ██║█████╔╝ ██║   ██║",
  "  ╚██╔╝  ██║██╔═██╗ ██║   ██║",
  "   ██║   ██║██║  ██╗╚██████╔╝",
  "   ╚═╝   ╚═╝╚═╝  ╚═╝ ╚═════╝ ",
] as const;
export const SPINNER_FRAMES = ["✦", "✧", "✶", "✷"] as const;
