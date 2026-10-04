import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import type { MessageColor, MessageContent } from "./types.js";

type ToolCallEvent = Extract<AgentProgressEvent, { readonly type: "tool_called" }>;
type ToolResultEvent = Extract<AgentProgressEvent, { readonly type: "tool_output" }>;
type TodoResultStatus = "completed" | "in_progress" | "pending";

interface TodoResultItem {
  readonly status: TodoResultStatus;
  readonly text: string;
}

interface StructuredToolResult {
  readonly display?: unknown;
  readonly error?: unknown;
  readonly isError: boolean;
  readonly llmContent: string;
}

interface ToolValidationIssue {
  readonly message: string;
  readonly path: string;
}

const BASH_PREVIEW_LINE_LIMIT = 3;
const READ_PREVIEW_LINE_LIMIT = 4;
const TOOL_CALL_DETAIL_CHARACTER_LIMIT = 240;
const TOOL_DETAIL_LINE_LIMIT = 6;

export function formatRuntimeEvent(event: AgentProgressEvent): MessageContent | undefined {
  switch (event.type) {
    case "checkpoint_saved":
      return undefined;
    case "evaluation_finished":
      return {
        details: [
          `Checks: ${event.counts.passed} passed, ${event.counts.failed} failed, ${event.counts.error} error, ${event.counts["not-run"]} not-run`,
          `Attempts: ${event.attempts}`,
          ...event.failedChecks
            .slice(0, 5)
            .map((check) => `${check.id} (${check.status}): ${check.summary}`),
        ],
        text: `Evaluation ${event.decision}: ${event.grade} (${(event.overallScore * 100).toFixed(1)})`,
      };
    case "context_compacted":
      return {
        text: `Context compacted: ${event.beforeEntries} -> ${event.afterEntries} entries`,
      };
    case "session_resumed":
      return {
        ...(event.inFlightOperations > 0 || event.continuation !== undefined
          ? {
              details: [
                ...(event.inFlightOperations > 0
                  ? [`In-flight operations: ${event.inFlightOperations}`]
                  : []),
                ...(event.continuation === undefined
                  ? []
                  : [`Continuation: ${event.continuation}`]),
              ],
            }
          : {}),
        text: `Session resumed: ${event.sessionId}`,
      };
    case "runtime_boundary_changed":
      return {
        details: [`Reason: ${event.reason}`],
        text: `Runtime boundary changed: ${event.from} -> ${event.to}`,
      };
    case "prompt_risk_detected":
      return {
        details: event.findings
          .slice(0, 5)
          .map(
            (finding) =>
              `${finding.code} · ${finding.source}${finding.sourceId ? `:${finding.sourceId}` : ""} · ${finding.trust}`,
          ),
        text: `Prompt risk detected: ${event.findings.length} finding(s)`,
      };
    case "stage_started":
      return {
        text: `Stage ${event.stage} started (${event.stageId})`,
      };
    case "stage_finished":
      return {
        ...(event.reason !== undefined ? { details: [`Reason: ${event.reason}`] } : {}),
        text: `Stage ${event.stageId} ${event.outcome}`,
      };
    case "agent_profile_changed":
      return {
        details: [`Type: ${event.agentType}`, `Profile: ${event.profileId}`],
        text: `Agent Profile ${event.action}`,
      };
    case "subagent_spawned":
      return {
        details: [`Task: ${event.taskId}`, `Profile: ${event.profileId}`],
        text: `Subagent ${event.agentName ?? event.agentType} spawned`,
      };
    case "subagent_result":
      return {
        details: [`Task: ${event.taskId}`, `Profile: ${event.profileId}`],
        text: `Subagent ${event.agentName ?? event.agentId} ${event.status}`,
      };
    case "subagent_output":
      return undefined;
    case "skill_resolved":
      return {
        details: [`Source: ${event.source}`, `Digest: ${event.digest.slice(0, 8)}`],
        text: `Skill ${event.name} resolved`,
      };
    case "skill_activated":
      return {
        details: [`Target: ${event.targetId}`],
        text: `Skill ${event.name} activated`,
      };
    case "skill_worker_started":
      return {
        details: [`Worker: ${event.workerId}`],
        text: `Skill ${event.name} worker started`,
      };
    case "skill_worker_finished":
      return {
        details: [`Worker: ${event.workerId}`],
        text: `Skill ${event.name} worker ${event.status}`,
      };
    case "task_snapshot":
      return {
        text: `Tasks: ${event.completed} completed, ${event.inProgress} in progress, ${event.pending} pending, ${event.blocked} blocked`,
      };
    case "session_failed":
      return {
        details: [
          `Session: ${event.sessionId}`,
          ...(event.source !== undefined ? [`Source: ${event.source}`] : []),
        ],
        text: `Error: ${event.error}`,
      };
    case "agent_updated":
    case "handoff":
    case "memory_operation":
    case "message_delta":
    case "reasoning":
    case "session_cancelled":
    case "session_finished":
    case "session_started":
    case "tool_called":
    case "tool_output":
    case "usage_updated":
    case "user_question_cancelled":
    case "user_question_requested":
    case "user_question_resolved":
      return undefined;
  }
}

export function formatToolCall(event: ToolCallEvent): MessageContent {
  const input = asRecord(event.input);

  switch (event.toolName) {
    case "AskUserQuestion":
    case "askUserTool": {
      const structuredQuestion = firstStructuredQuestion(input);
      const question =
        readString(input, "question") ?? readString(structuredQuestion, "question") ?? "unknown";
      const questions = input?.questions;
      return {
        text: formatCall("AskUser", [
          ["header", readString(structuredQuestion, "header")],
          ["question", question],
          ["questions", Array.isArray(questions) ? questions.length : undefined],
        ]),
      };
    }
    case "bashTool":
      return formatBashCall(input, event.summary);
    case "grepTool":
      return {
        text: formatCall("Grep", [
          ["pattern", readString(input, "pattern") ?? "unknown"],
          ["path", readString(input, "path") ?? "."],
          ["case_sensitive", readBoolean(input, "case_sensitive")],
          ["include_hidden", readBoolean(input, "include_hidden")],
          ["max_results", readNumber(input, "max_results")],
        ]),
      };
    case "lsTool":
      return {
        text: formatCall("Ls", [
          ["path", readString(input, "path") ?? "."],
          ["include_hidden", readBoolean(input, "include_hidden")],
          ["max_entries", readNumber(input, "max_entries")],
        ]),
      };
    case "treeTool":
      return {
        text: formatCall("Tree", [
          ["path", readString(input, "path") ?? "."],
          ["max_depth", readNumber(input, "max_depth")],
          ["include_hidden", readBoolean(input, "include_hidden")],
          ["max_entries", readNumber(input, "max_entries")],
        ]),
      };
    case "readTool":
      return {
        text: formatCall("Read", [
          ["file_path", readString(input, "file_path") ?? "unknown"],
          ["line_start", readNumber(input, "line_start")],
          ["line_end", readNumber(input, "line_end")],
        ]),
      };
    case "editTool":
      return {
        text: formatCall("Edit", [
          ["file_path", readString(input, "file_path") ?? "unknown"],
          ["replace_all", readBoolean(input, "replace_all")],
        ]),
      };
    case "writeTool":
      return {
        text: formatCall("Write", [["file_path", readString(input, "file_path") ?? "unknown"]]),
      };
    case "delegateTaskTool": {
      const task = readString(input, "prompt");
      return {
        ...(task !== undefined ? { details: [formatCallDetail("Task", task)] } : {}),
        text: formatCall("Delegate", [["agent", readString(input, "agent_key") ?? "unknown"]]),
      };
    }
    case "agentRunTool": {
      const task = readString(input, "prompt");
      return {
        ...(task !== undefined ? { details: [formatCallDetail("Task", task)] } : {}),
        text: formatCall("Agent", [["profile", readString(input, "profile_id") ?? "unknown"]]),
      };
    }
    case "textEditorTool":
      return formatTextEditorCall(input);
    case "todoWriteTool":
      return formatTodoCall(input);
    default:
      return {
        text: formatCall(event.title || "Tool", [["action", event.summary]]),
      };
  }
}

export function formatToolResult(event: ToolResultEvent, input: unknown): MessageContent {
  const structuredResult = asStructuredToolResult(event.output);
  if (structuredResult !== undefined) {
    return formatStructuredToolResult(event, structuredResult, input);
  }

  const rawOutputText = formatValue(event.output);
  const outputText = rawOutputText.trim();

  if (outputText.startsWith("Error:")) {
    return splitResult(outputText, TOOL_DETAIL_LINE_LIMIT);
  }

  if (event.toolName === "readTool") {
    return formatReadResult(event.output);
  }

  if (event.toolName === "textEditorTool") {
    const inputRecord = asRecord(input);
    const command = readString(inputRecord, "command");

    if (command === "view") {
      return formatReadResult(event.output);
    }

    if (command === "str_replace") {
      return formatReplaceResult(event.output, inputRecord);
    }

    const displayText = stripReadLineNumbers(rawOutputText).trimEnd();

    if (displayText.trim()) {
      return splitResult(displayText, TOOL_DETAIL_LINE_LIMIT);
    }
  }

  if (event.toolName === "todoWriteTool") {
    return formatTodoResult(event.output, event.summary);
  }

  if (event.toolName === "delegateTaskTool" || event.toolName === "agentRunTool") {
    return formatSubagentToolResult(event.toolName, outputText, asRecord(input));
  }

  if (!outputText) {
    return {
      text: `${event.title || "Tool"} finished`,
    };
  }

  if (event.toolName === "bashTool") {
    return splitResult(outputText, BASH_PREVIEW_LINE_LIMIT);
  }

  return splitResult(outputText, TOOL_DETAIL_LINE_LIMIT);
}

function formatStructuredToolResult(
  event: ToolResultEvent,
  result: StructuredToolResult,
  input: unknown,
): MessageContent {
  if (result.isError) {
    return formatStructuredToolError(event, result);
  }

  const display = asRecord(result.display);
  if (
    display?.type === "diff" &&
    typeof display.oldText === "string" &&
    typeof display.newText === "string"
  ) {
    return formatDiffResult(display.oldText, display.newText);
  }

  if (event.toolName === "readTool") {
    return formatReadResult(result.llmContent);
  }

  const outputText = result.llmContent.trim();
  if (event.toolName === "delegateTaskTool" || event.toolName === "agentRunTool") {
    return formatSubagentToolResult(event.toolName, outputText, asRecord(input));
  }
  if (!outputText) {
    return {
      text: `${event.title || "Tool"} finished`,
    };
  }

  return splitResult(
    outputText,
    event.toolName === "bashTool" ? BASH_PREVIEW_LINE_LIMIT : TOOL_DETAIL_LINE_LIMIT,
  );
}

function formatSubagentToolResult(
  toolName: "agentRunTool" | "delegateTaskTool",
  outputText: string,
  input: Record<string, unknown> | undefined,
): MessageContent {
  const parsed = parseJsonRecord(outputText);
  const agentName =
    toolName === "delegateTaskTool"
      ? (readString(input, "agent_key") ?? "subagent")
      : (readString(input, "profile_id") ?? readString(parsed, "profileId") ?? "subagent");
  const taskId = readString(parsed, "taskId");
  const status = readString(parsed, "status") ?? "succeeded";

  return {
    ...(taskId !== undefined ? { details: [`Task: ${taskId}`] } : {}),
    text: `${agentName} ${status}`,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function formatStructuredToolError(
  event: ToolResultEvent,
  result: StructuredToolResult,
): MessageContent {
  const error = asRecord(result.error);

  if (error?.code === "TOOL_INPUT_VALIDATION_ERROR") {
    const issues = readValidationIssues(error.issues);
    const [firstIssue, ...remainingIssues] = issues;

    if (firstIssue !== undefined) {
      return {
        ...(remainingIssues.length > 0
          ? { details: remainingIssues.map(formatValidationIssue) }
          : {}),
        text: `Error: ${formatValidationIssue(firstIssue)}`,
      };
    }

    return {
      text: "Error: Invalid tool input",
    };
  }

  const message = result.llmContent.trim() || `${event.title || "Tool"} failed`;
  return splitResult(
    message.startsWith("Error:") ? message : `Error: ${message}`,
    TOOL_DETAIL_LINE_LIMIT,
  );
}

function readValidationIssues(value: unknown): readonly ToolValidationIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const issue = asRecord(item);
    const message = readString(issue, "message");
    const path = typeof issue?.path === "string" ? issue.path.trim() : "";

    return message === undefined ? [] : [{ message, path }];
  });
}

function formatValidationIssue(issue: ToolValidationIssue): string {
  return `Invalid tool input${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`;
}

function formatBashCall(
  input: Record<string, unknown> | undefined,
  summary: string,
): MessageContent {
  if (readBoolean(input, "restart") === true) {
    return {
      text: formatCall("Bash", [["restart", true]]),
    };
  }

  const command = readString(input, "command");

  return {
    text: command ? `Bash(${formatInline(command)})` : formatCall("Bash", [["action", summary]]),
  };
}

function formatTextEditorCall(input: Record<string, unknown> | undefined): MessageContent {
  const command = readString(input, "command");
  const path = readString(input, "path") ?? "unknown";

  switch (command) {
    case "view":
      return {
        text: formatCall("Read", [
          ["file_path", path],
          ["view_range", readNumberArray(input, "view_range")],
        ]),
      };
    case "create":
      return {
        text: formatCall("Create", [["file_path", path]]),
      };
    case "insert":
      return {
        text: formatCall("Edit", [
          ["file_path", path],
          ["insert_line", readNumber(input, "insert_line")],
        ]),
      };
    case "str_replace":
      return {
        text: formatCall("Edit", [["file_path", path]]),
      };
    default:
      return {
        text: formatCall("Edit", [
          ["file_path", path],
          ["command", command ?? "unknown"],
        ]),
      };
  }
}

function formatTodoCall(input: Record<string, unknown> | undefined): MessageContent {
  const items = Array.isArray(input?.items) ? input.items : [];
  const activeItem = items
    .map((item) => asRecord(item))
    .find((item) => readString(item, "status") === "in_progress");

  return {
    text: formatCall("Update Todos", [
      ["items", items.length],
      ["active", readString(activeItem, "content")],
    ]),
  };
}

function formatReadResult(output: unknown): MessageContent {
  const text = stripReadLineNumbers(formatValue(output)).trimEnd();

  if (!text.trim()) {
    return {
      text: "(empty output)",
    };
  }

  return splitResult(text, READ_PREVIEW_LINE_LIMIT);
}

export function stripReadLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\d+:\s?/u, ""))
    .join("\n");
}

function formatReplaceResult(
  output: unknown,
  input: Record<string, unknown> | undefined,
): MessageContent {
  const oldText = readString(input, "old_str");
  const newText = readString(input, "new_str") ?? "";

  if (oldText === undefined) {
    return {
      text: formatValue(output) || "Edit finished",
    };
  }

  return formatDiffResult(oldText, newText);
}

function formatDiffResult(oldText: string, newText: string): MessageContent {
  const removedLines = trimBoundaryBlankLines(oldText.split("\n"));
  const addedLines = trimBoundaryBlankLines(newText.split("\n"));
  const diffLines = [
    ...removedLines.map((line) => `- ${line}`),
    ...addedLines.map((line) => `+ ${line}`),
  ];
  const visibleLines = diffLines.slice(0, TOOL_DETAIL_LINE_LIMIT);
  const remainingLineCount = diffLines.length - visibleLines.length;

  return {
    ...(visibleLines.length > 0 || remainingLineCount > 0
      ? {
          details: [
            ...visibleLines,
            ...(remainingLineCount > 0 ? [`... (+${remainingLineCount} line(s))`] : []),
          ],
        }
      : {}),
    text: `${addedLines.length} addition(s) and ${removedLines.length} deletion(s)`,
  };
}

function formatTodoResult(output: unknown, summary: string): MessageContent {
  const items = parseTodoResultItems(output);

  return {
    ...(items.length > 0
      ? {
          detailColors: items.map((item) => getTodoItemColor(item.status)),
          details: items.map((item) => item.text),
        }
      : {}),
    text: items.length > 0 ? formatTodoSummary(items) : summary,
  };
}

function splitResult(text: string, lineLimit: number): MessageContent {
  const lines = trimBoundaryBlankLines(text.split("\n"));
  const visibleLines = lines.slice(0, lineLimit);
  const remainingLineCount = lines.length - visibleLines.length;
  const [firstLine = "(empty output)", ...details] = visibleLines;

  return {
    ...(details.length > 0 || remainingLineCount > 0
      ? {
          details: [
            ...details,
            ...(remainingLineCount > 0 ? [`... (+${remainingLineCount} line(s))`] : []),
          ],
        }
      : {}),
    text: firstLine,
  };
}

function trimBoundaryBlankLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function parseTodoResultItems(output: unknown): readonly TodoResultItem[] {
  if (typeof output !== "string") {
    return [];
  }

  return output
    .split("\n")
    .map((line) => {
      const match = /^\d+\.\s+\[([ x-])\]\s+(.+)$/u.exec(line.trim());

      if (match === null) {
        return undefined;
      }

      const status = match[1];
      const content = match[2] ?? "";

      if (status === "x") {
        return {
          status: "completed",
          text: `✓ ${content}`,
        } satisfies TodoResultItem;
      }

      if (status === "-") {
        return {
          status: "in_progress",
          text: `□ ${content}`,
        } satisfies TodoResultItem;
      }

      return {
        status: "pending",
        text: `□ ${content}`,
      } satisfies TodoResultItem;
    })
    .filter((item) => item !== undefined);
}

function getTodoItemColor(status: TodoResultStatus): MessageColor {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "cyan";
    case "pending":
      return "gray";
  }
}

function formatTodoSummary(items: readonly TodoResultItem[]): string {
  const completedCount = items.filter((item) => item.status === "completed").length;
  const inProgressCount = items.filter((item) => item.status === "in_progress").length;

  return `Status updated: ${completedCount} completed, ${inProgressCount} in progress.`;
}

function formatCall(name: string, entries: readonly (readonly [string, unknown])[]): string {
  const argumentsText = entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${formatArgument(value)}`)
    .join(", ");

  return `${name}(${argumentsText})`;
}

function formatInline(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function formatCallDetail(label: string, value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  const detail =
    normalized.length <= TOOL_CALL_DETAIL_CHARACTER_LIMIT
      ? normalized
      : `${normalized.slice(0, TOOL_CALL_DETAIL_CHARACTER_LIMIT - 3)}...`;
  return `${label}: ${detail}`;
}

function formatArgument(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.join(", ")}]`;
  }

  return String(value);
}

function asStructuredToolResult(value: unknown): StructuredToolResult | undefined {
  const record = asRecord(value);

  if (typeof record?.isError !== "boolean" || typeof record.llmContent !== "string") {
    return undefined;
  }

  return {
    ...(record.display !== undefined ? { display: record.display } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    isError: record.isError,
    llmContent: record.llmContent,
  };
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

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];

  return typeof value === "boolean" ? value : undefined;
}

function readNumberArray(
  record: Record<string, unknown> | undefined,
  key: string,
): readonly number[] | undefined {
  const value = record?.[key];

  return Array.isArray(value) && value.every((item) => typeof item === "number")
    ? value
    : undefined;
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
