export interface ToolTraceDetails {
  readonly summary: string;
  readonly title: string;
}

const TOOL_TITLES: Record<string, string> = {
  AskUserQuestion: "AskUser",
  askUserTool: "AskUser",
  bashTool: "Bash",
  editTool: "Edit",
  grepTool: "Grep",
  lsTool: "Ls",
  readTool: "Read",
  textEditorTool: "Edit",
  todoWriteTool: "TodoWrite",
  treeTool: "Tree",
  writeTool: "Write",
};

const DISPLAY_TEXT_LIMIT = 180;

export function getToolTraceDetails(toolName: string, input?: unknown): ToolTraceDetails {
  const title = getToolTitle(toolName);

  return {
    summary: summarizeToolInput(toolName, input),
    title,
  };
}

export function getToolOutputTraceDetails(toolName: string, output?: unknown): ToolTraceDetails {
  const title = getToolTitle(toolName);

  return {
    summary: summarizeToolOutput(toolName, title, output),
    title,
  };
}

export function formatToolTraceLabel(details: ToolTraceDetails): string {
  return `${details.title}: ${details.summary}`;
}

function getToolTitle(toolName: string): string {
  return TOOL_TITLES[toolName] ?? "Tool";
}

function summarizeToolInput(toolName: string, input: unknown): string {
  const record = asRecord(input);

  switch (toolName) {
    case "AskUserQuestion":
    case "askUserTool": {
      const structuredQuestion = firstStructuredQuestion(record);
      const question =
        (record ? readString(record, "question") : undefined) ??
        (structuredQuestion ? readString(structuredQuestion, "question") : undefined);

      return question ? `ask ${formatInline(question)}` : "ask user";
    }
    case "bashTool": {
      if (record === undefined) {
        return "run bash command";
      }

      if (record.restart === true) {
        return "restart bash session";
      }

      const command = readString(record, "command");

      return command ? `run ${formatInline(command)}` : "run bash command";
    }
    case "grepTool": {
      const pattern = record ? readString(record, "pattern") : undefined;
      const path = record ? readString(record, "path") : undefined;

      if (pattern && path) {
        return `search ${formatInline(pattern)} in ${path}`;
      }

      return pattern ? `search ${formatInline(pattern)}` : "search files";
    }
    case "lsTool": {
      const path = record ? readString(record, "path") : undefined;

      return `list ${path || "."}`;
    }
    case "readTool": {
      const path = record ? readString(record, "file_path") : undefined;

      return path ? `read ${path}` : "read file";
    }
    case "editTool": {
      const path = record ? readString(record, "file_path") : undefined;

      return path ? `edit ${path}` : "edit file";
    }
    case "writeTool": {
      const path = record ? readString(record, "file_path") : undefined;

      return path ? `write ${path}` : "write file";
    }
    case "textEditorTool": {
      const command = record ? readString(record, "command") : undefined;
      const path = record ? readString(record, "path") : undefined;

      if (command && path) {
        return `${command} ${path}`;
      }

      return command || "edit file";
    }
    case "todoWriteTool": {
      const items = record?.items;

      if (!Array.isArray(items)) {
        return "write todo list";
      }

      const activeItem = items
        .map((item) => asRecord(item))
        .find((item) => item?.status === "in_progress");
      const activeContent = activeItem ? readString(activeItem, "content") : undefined;
      const itemLabel = items.length === 1 ? "item" : "items";

      return activeContent
        ? `write ${items.length} ${itemLabel}; active ${formatInline(activeContent)}`
        : `write ${items.length} ${itemLabel}`;
    }
    case "treeTool": {
      const path = record ? readString(record, "path") : undefined;
      const maxDepth = record ? readNumber(record, "max_depth") : undefined;

      return maxDepth === undefined
        ? `render tree ${path || "."}`
        : `render tree ${path || "."} depth ${maxDepth}`;
    }
    default:
      return "execute tool";
  }
}

function summarizeToolOutput(toolName: string, title: string, output: unknown): string {
  if (toolName === "todoWriteTool") {
    const todoSummary = summarizeTodoOutput(output);

    if (todoSummary) {
      return todoSummary;
    }
  }

  const text = formatValue(output);

  return text ? `finished ${formatInline(text)}` : `${title} finished`;
}

function summarizeTodoOutput(output: unknown): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }

  const text = output.trim();

  if (text === "TODO list is empty.") {
    return "0 pending · 0 in progress · 0 completed";
  }

  const items = text
    .split("\n")
    .map((line) => parseTodoOutputLine(line))
    .filter((item) => item !== undefined);

  if (items.length === 0) {
    return undefined;
  }

  const pendingCount = items.filter((item) => item.status === "pending").length;
  const activeItems = items.filter((item) => item.status === "in_progress");
  const completedCount = items.filter((item) => item.status === "completed").length;
  const countSummary = `${pendingCount} pending · ${activeItems.length} in progress · ${completedCount} completed`;
  const activeContent = activeItems[0]?.content;

  return activeContent ? `${countSummary} · active: ${formatInline(activeContent)}` : countSummary;
}

function parseTodoOutputLine(
  line: string,
):
  | { readonly content: string; readonly status: "completed" | "in_progress" | "pending" }
  | undefined {
  const match = /^\d+\.\s+\[([ x-])\]\s+(.+)$/u.exec(line.trim());

  if (match === null) {
    return undefined;
  }

  const statusToken = match[1];
  const content = match[2];

  if (content === undefined) {
    return undefined;
  }

  switch (statusToken) {
    case " ":
      return {
        content,
        status: "pending",
      };
    case "-":
      return {
        content,
        status: "in_progress",
      };
    case "x":
      return {
        content,
        status: "completed",
      };
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStructuredQuestion(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const questions = record?.questions;
  return Array.isArray(questions) ? asRecord(questions[0]) : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();

  return normalized.length > DISPLAY_TEXT_LIMIT
    ? `${normalized.slice(0, DISPLAY_TEXT_LIMIT - 1)}…`
    : normalized;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
