import { ProgressBar } from "@inkjs/ui";
import type { SessionState } from "@yiku/agent-orchestrator";
import { Box, Static, Text } from "ink";
import stringWidth from "string-width";
import {
  getSlashCommandGroup,
  SLASH_COMMAND_GROUPS,
  type SlashCommand,
  type SlashCommandGroup,
} from "../slash-commands/index.js";
import {
  DEFAULT_MODEL_LABEL,
  LAYOUT_SPACING,
  SLASH_COMMAND_MENU_MAX_VISIBLE_ROWS,
  SPINNER_FRAMES,
  YIKU_LOGO,
} from "./constants.js";
import type { FileEntry } from "./file-search.js";
import { MarkdownMessage } from "./markdown.js";
import {
  type ContextUsageDetails,
  formatContextWindow,
  formatDuration,
  formatPromptContextUsage,
  formatTokenCount,
  type SessionSummary,
} from "./session-metrics.js";
import { SubagentBlockView } from "./subagent-view.js";
import { getElapsedSeconds } from "./time.js";
import { ToolBlockView } from "./tool-view.js";
import type {
  ActiveCommand,
  AgentTimelineState,
  MessageContent,
  SessionMessage,
  SessionStatus,
  TimelineItem,
  TimelineToolItem,
} from "./types.js";

const SLASH_COMMAND_NAME_WIDTH = 32;
const SKILL_HINT_MAX_ROWS = 2;
const SLASH_COMMAND_GROUP_COLORS: Readonly<Record<SlashCommandGroup, string>> = {
  AGENTS: "blue",
  GENERAL: "gray",
  RUNTIME: "magenta",
  SESSION: "cyan",
  SKILLS: "white",
  STATUS: "green",
  WORKFLOWS: "yellow",
};
const YIKU_LOGO_WIDTH = Math.max(...YIKU_LOGO.map((line) => line.length));
const CONTEXT_ROW_IDS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const EMPTY_AGENTS: readonly AgentTimelineState[] = [];

export interface HeaderContext {
  readonly model: string;
  readonly workspaceDir: string;
}

export function Header({
  context,
  modelFallback = DEFAULT_MODEL_LABEL,
  userName = resolveUserName(),
  workspaceFallback,
}: {
  readonly context?: HeaderContext | undefined;
  readonly modelFallback?: string | undefined;
  readonly userName?: string | undefined;
  readonly workspaceFallback: string;
}) {
  const model = context?.model ?? modelFallback;
  const workspaceDir = context?.workspaceDir ?? workspaceFallback;

  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor="magenta"
      padding={1}
      marginTop={LAYOUT_SPACING.header}
      width="100%"
    >
      <Box flexShrink={0} width={YIKU_LOGO_WIDTH}>
        <Text color="magenta">{YIKU_LOGO.join("\n")}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={2} paddingTop={0}>
        <Text wrap="truncate">
          <Text color="gray">Welcome back, </Text>
          <Text color="cyan">{userName || "user"}</Text>
        </Text>
        <Text wrap="truncate">
          <Text color="gray">Model: </Text>
          <Text color="yellow">{model}</Text>
        </Text>
        <Text wrap="truncate">
          <Text color="gray">Workspace: </Text>
          <Text color="cyan">{workspaceDir}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function resolveUserName(): string {
  return process.env.USER ?? process.env.USERNAME ?? "user";
}

export function Timeline({
  activeCommand,
  activeAssistant,
  activeTool,
  agents = EMPTY_AGENTS,
  generation,
  items,
  nowMs,
  outputStyle = "default",
  spinnerIndex,
  staticTranscript = true,
  status,
}: {
  readonly activeCommand?: ActiveCommand | undefined;
  readonly activeAssistant?: SessionMessage | undefined;
  readonly activeTool?: TimelineToolItem | undefined;
  readonly agents?: readonly AgentTimelineState[] | undefined;
  readonly generation: number;
  readonly items: readonly TimelineItem[];
  readonly nowMs: number;
  readonly outputStyle?: SessionState["outputStyle"] | undefined;
  readonly spinnerIndex: number;
  readonly staticTranscript?: boolean | undefined;
  readonly status: SessionStatus;
}) {
  return (
    <>
      {staticTranscript ? (
        <Static items={[...items]} key={generation} style={{ width: "100%" }}>
          {(item) => <TimelineItemView item={item} key={item.id} outputStyle={outputStyle} />}
        </Static>
      ) : (
        items.map((item) => (
          <TimelineItemView item={item} key={item.id} outputStyle={outputStyle} />
        ))
      )}
      <Box flexDirection="column" marginBottom={LAYOUT_SPACING.live} width="100%">
        {activeAssistant ? <MessageView message={activeAssistant} /> : null}
        {activeTool ? <ToolBlockView item={activeTool} outputStyle={outputStyle} /> : null}
        {agents.map((agent) => (
          <SubagentBlockView agent={agent} key={agent.agentId} outputStyle={outputStyle} />
        ))}
        {status.kind === "processing" ? (
          <ThinkingView
            nowMs={nowMs}
            spinnerIndex={spinnerIndex}
            startedAtMs={status.startedAtMs}
          />
        ) : null}
        {activeCommand ? (
          <CommandProgressView command={activeCommand} nowMs={nowMs} spinnerIndex={spinnerIndex} />
        ) : null}
        {status.kind === "error" ? (
          <Box flexDirection="column">
            <Text color="red">! Error: {status.message}</Text>
            {status.source ? (
              <Text color="gray">
                {"  "}
                {status.source}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </>
  );
}

function TimelineItemView({
  item,
  outputStyle,
}: {
  readonly item: TimelineItem;
  readonly outputStyle: SessionState["outputStyle"];
}) {
  switch (item.kind) {
    case "agent":
      return <SubagentBlockView agent={item.agent} outputStyle={outputStyle} />;
    case "header":
      return (
        <Header
          context={{
            model: item.model,
            workspaceDir: item.workspaceDir,
          }}
          userName={resolveUserName()}
          workspaceFallback={item.workspaceDir}
        />
      );
    case "message":
      return <MessageView message={item.message} />;
    case "runtime":
      return <RuntimeEventView content={item.content} />;
    case "session-summary":
      return <SessionSummaryView summary={item.summary} />;
    case "summary":
      return (
        <Box justifyContent="flex-end" paddingRight={1} width="100%">
          <Text color="gray">Thought for {item.durationSeconds}s</Text>
        </Box>
      );
    case "tool":
      return <ToolBlockView item={item} outputStyle={outputStyle} />;
  }
}

function CommandMessageLine({
  color,
  indent,
  line,
}: {
  readonly color: string;
  readonly indent: number;
  readonly line: string;
}) {
  const treeLine = /^([├└] )(.*)$/u.exec(line);

  return (
    <Box flexShrink={1} marginLeft={indent}>
      {treeLine === null ? (
        <Text color={color}>{line || " "}</Text>
      ) : (
        <>
          <Box flexShrink={0}>
            <Text color={color}>{treeLine[1]}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={color}>{treeLine[2] || " "}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

export function SessionSummaryView({ summary }: { readonly summary: SessionSummary }) {
  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
      <Text color="gray">Session ID: {summary.sessionId}</Text>
      <Text color="gray">Model: {summary.model}</Text>
      <Text color="gray">Context Window: {formatContextWindow(summary)}</Text>
      <Text color="gray">
        Long-running: {summary.stageCount} stages, {summary.checkpointCount} checkpoints
      </Text>
      <Text color="gray">
        Tasks: {summary.tasks.completed} completed, {summary.tasks.inProgress} in progress,{" "}
        {summary.tasks.pending} pending, {summary.tasks.blocked} blocked
      </Text>
      {summary.pauseReason ? <Text color="yellow">Paused: {summary.pauseReason}</Text> : null}
      <Text color="gray">Session</Text>
      <Text color="gray">Total duration (API): {formatDuration(summary.apiDurationMs)}</Text>
      <Text color="gray">Total duration (wall): {formatDuration(summary.wallDurationMs)}</Text>
      <Text color="gray">
        Total code changes: {summary.addedLines} lines added, {summary.removedLines} lines removed
      </Text>
      <Text color="gray">Usage by model:</Text>
      {summary.usageByModel.length > 0 ? (
        summary.usageByModel.map((usage) => (
          <Text color="gray" key={usage.model}>
            {"    "}
            {usage.model}: {formatTokenCount(usage.inputTokens)} input,{" "}
            {formatTokenCount(usage.outputTokens)} output,{" "}
            {formatTokenCount(usage.cachedInputTokens)} cache read
          </Text>
        ))
      ) : (
        <Text color="gray">{"    "}none</Text>
      )}
      <Text color="gray">Tool calls:</Text>
      {summary.toolCalls.length > 0 ? (
        summary.toolCalls.map((tool) => (
          <Text color="gray" key={tool.name}>
            {"    "}
            {tool.name}: {tool.calls} {pluralize("call", tool.calls)}, {tool.errors}{" "}
            {pluralize("error", tool.errors)}, {formatDuration(tool.durationMs)}
          </Text>
        ))
      ) : (
        <Text color="gray">{"    "}none</Text>
      )}
    </Box>
  );
}

function RuntimeEventView({ content }: { readonly content: MessageContent }) {
  const isError = content.text.startsWith("Error:");

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
      <Text>
        <Text color={isError ? "red" : "magenta"}>● </Text>
        <Text color={isError ? "red" : "gray"}>{content.text}</Text>
      </Text>
      {content.details && content.details.length > 0 ? (
        <Text color="gray">
          {"  "}
          {content.details.join("\n  ")}
        </Text>
      ) : null}
    </Box>
  );
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

export function MessageView({
  message,
}: {
  readonly key?: number;
  readonly message: SessionMessage;
}) {
  if (message.role === "user") {
    return (
      <Box backgroundColor="blue" marginBottom={LAYOUT_SPACING.item}>
        <Text color="white">
          {"> "}
          <InlineText text={message.text} />
        </Text>
      </Box>
    );
  }

  if (message.role === "command") {
    if (message.contextUsage !== undefined) {
      return (
        <ContextUsageView title={message.title ?? "Context Usage"} usage={message.contextUsage} />
      );
    }
    const color = message.tone === "error" ? "red" : "white";
    const lineColors = message.lineColors;
    const lineIndents = message.lineIndents;
    const lines = message.text.split("\n");
    const occurrences = new Map<string, number>();
    return (
      <Box flexDirection="row" marginBottom={LAYOUT_SPACING.item} width="100%">
        <Box flexShrink={0}>
          <Text color="gray">⎿ </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text bold color={color}>
            {message.title ?? "Command Result"}
          </Text>
          {lines.map((line, index) => {
            const occurrence = (occurrences.get(line) ?? 0) + 1;
            occurrences.set(line, occurrence);
            const lineColor =
              lineColors?.[index] ??
              (line.startsWith("●") ? "cyan" : line.startsWith("○") ? "gray" : color);
            return (
              <CommandMessageLine
                color={lineColor}
                indent={normalizeLineIndent(lineIndents?.[index])}
                key={`${line}:${occurrence}`}
                line={line}
              />
            );
          })}
        </Box>
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
        <Text>
          <Text color="gray">● </Text>
          <InlineText text={message.text} />
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
      <Box flexDirection="row">
        <Text color="white">● </Text>
        <Box flexDirection="column" flexGrow={1}>
          <MarkdownMessage text={message.text} />
        </Box>
      </Box>
    </Box>
  );
}

function normalizeLineIndent(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function ContextUsageView({
  title,
  usage,
}: {
  readonly title: string;
  readonly usage: ContextUsageDetails;
}) {
  const contextWindow = usage.contextWindow;
  const ratio =
    contextWindow === undefined || contextWindow <= 0
      ? undefined
      : usage.usedTokens / contextWindow;
  const cells = contextWindow === undefined ? [] : contextCells(usage);

  return (
    <Box flexDirection="row" marginBottom={LAYOUT_SPACING.item}>
      <Text color="gray">⎿ </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="white">
          {title}
        </Text>
        <Box flexDirection="row">
          {cells.length > 0 ? (
            <Box flexDirection="column" flexShrink={0} marginRight={4}>
              {CONTEXT_ROW_IDS.map((rowId) => {
                const row = Number(rowId);
                return (
                  <Box flexDirection="row" key={rowId}>
                    {cells.slice(row * 10, row * 10 + 10).map((cell) => (
                      <Text
                        color={
                          cell.kind === "used" ? "cyan" : cell.kind === "free" ? "gray" : "red"
                        }
                        key={cell.id}
                      >
                        {cell.kind === "used" ? "◉ " : cell.kind === "free" ? "○ " : "⊠ "}
                      </Text>
                    ))}
                  </Box>
                );
              })}
            </Box>
          ) : null}
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text bold backgroundColor="red" color="white">
                {usage.model}
              </Text>
              <Text bold color="white">
                {" · "}
                {formatTokenCount(usage.usedTokens)}
                {contextWindow !== undefined ? `/${formatTokenCount(contextWindow)}` : ""} tokens
                {ratio !== undefined
                  ? ` (${formatPercentage(ratio)}${
                      usage.contextWindowSource === "inferred" ? ", limit est." : ""
                    })`
                  : ""}
              </Text>
            </Box>
            <Text color="white">Estimated usage by category</Text>
            {usage.categories.map((category) => (
              <Text key={category.key}>
                <Text color="cyan">◉</Text> {category.label}: {formatTokenCount(category.tokens)}{" "}
                tokens {formatCategoryPercentage(category.tokens, contextWindow)}
              </Text>
            ))}
            {usage.freeTokens !== undefined ? (
              <Text>
                <Text color="gray">○</Text> Free space: {formatTokenCount(usage.freeTokens)} tokens{" "}
                {formatCategoryPercentage(usage.freeTokens, contextWindow)}
              </Text>
            ) : (
              <Text color="gray">○ Context limit unavailable</Text>
            )}
            {contextWindow !== undefined ? (
              <Text>
                <Text color="red">⊠</Text> Autocompact buffer:{" "}
                {formatTokenCount(usage.autocompactBufferTokens)} tokens{" "}
                {formatCategoryPercentage(usage.autocompactBufferTokens, contextWindow)}
              </Text>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

interface ContextCell {
  readonly id: string;
  readonly kind: "buffer" | "free" | "used";
}

function contextCells(usage: ContextUsageDetails): readonly ContextCell[] {
  const contextWindow = usage.contextWindow;
  if (contextWindow === undefined || contextWindow <= 0) {
    return [];
  }
  const used = Math.min(100, Math.round((usage.usedTokens / contextWindow) * 100));
  const buffer = Math.min(
    100 - used,
    Math.round((usage.autocompactBufferTokens / contextWindow) * 100),
  );
  const free = 100 - used - buffer;
  return [
    ...Array.from({ length: used }, () => "used" as const),
    ...Array.from({ length: free }, () => "free" as const),
    ...Array.from({ length: buffer }, () => "buffer" as const),
  ].map((kind, index) => ({
    id: `context-cell-${index}`,
    kind,
  }));
}

function formatCategoryPercentage(tokens: number, contextWindow: number | undefined): string {
  return contextWindow === undefined || contextWindow <= 0
    ? ""
    : `(${formatPercentage(tokens / contextWindow)})`;
}

function formatPercentage(ratio: number): string {
  return `${Number((Math.max(0, ratio) * 100).toFixed(1))}%`;
}

function InlineText({
  text,
  textColor,
}: {
  readonly text: string;
  readonly textColor?: string | undefined;
}) {
  const segments = getInlineSegments(text);

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "code") {
          return (
            <Text color="green" key={segment.key}>
              {segment.text}
            </Text>
          );
        }

        return textColor ? (
          <Text color={textColor} key={segment.key}>
            {segment.text}
          </Text>
        ) : (
          <Text key={segment.key}>{segment.text}</Text>
        );
      })}
    </>
  );
}

interface InlineSegment {
  readonly key: string;
  readonly kind: "code" | "text";
  readonly text: string;
}

function getInlineSegments(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  const codePattern = /`([^`]+)`/gu;
  let cursor = 0;

  for (const match of text.matchAll(codePattern)) {
    const matchIndex = match.index;
    const codeText = match[1] as string;

    if (matchIndex > cursor) {
      segments.push({
        key: `text:${cursor}`,
        kind: "text",
        text: text.slice(cursor, matchIndex),
      });
    }

    segments.push({
      key: `code:${matchIndex}`,
      kind: "code",
      text: codeText,
    });
    cursor = matchIndex + match[0].length;
  }

  if (cursor < text.length || segments.length === 0) {
    segments.push({
      key: `text:${cursor}`,
      kind: "text",
      text: text.slice(cursor),
    });
  }

  return segments;
}

function ThinkingView({
  nowMs,
  spinnerIndex,
  startedAtMs,
}: {
  readonly nowMs: number;
  readonly spinnerIndex: number;
  readonly startedAtMs: number;
}) {
  const spinnerFrame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] as string;

  return (
    <Box marginBottom={LAYOUT_SPACING.item} paddingX={1}>
      <Text color="red">
        {spinnerFrame} Thinking...{" "}
        <Text color="gray">({getElapsedSeconds(startedAtMs, nowMs)}s)</Text>
      </Text>
    </Box>
  );
}

function CommandProgressView({
  command,
  nowMs,
  spinnerIndex,
}: {
  readonly command: ActiveCommand;
  readonly nowMs: number;
  readonly spinnerIndex: number;
}) {
  const spinnerFrame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] as string;

  return (
    <Box marginBottom={LAYOUT_SPACING.item} paddingX={1}>
      <Text color="red">
        {spinnerFrame} {command.label}...{" "}
        <Text color="gray">({getElapsedSeconds(command.startedAtMs, nowMs)}s)</Text>
      </Text>
    </Box>
  );
}

export function SlashCommandMenu({
  commands,
  maxVisibleRows = SLASH_COMMAND_MENU_MAX_VISIBLE_ROWS,
  selectedIndex,
  terminalColumns = 100,
}: {
  readonly commands: readonly SlashCommand[];
  readonly maxVisibleRows?: number | undefined;
  readonly selectedIndex: number;
  readonly terminalColumns?: number | undefined;
}) {
  const entries = SLASH_COMMAND_GROUPS.flatMap((group) =>
    commands
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => getSlashCommandGroup(command) === group),
  );
  const maximumRows = Math.max(4, Math.floor(maxVisibleRows));
  const descriptionWidth = Math.max(1, Math.floor(terminalColumns) - SLASH_COMMAND_NAME_WIDTH);
  const visibleEntries = slashCommandMenuWindow(
    entries,
    selectedIndex,
    maximumRows,
    descriptionWidth,
  );
  const groups = SLASH_COMMAND_GROUPS.map((group) => ({
    count: entries.filter(({ command }) => getSlashCommandGroup(command) === group).length,
    entries: visibleEntries.filter(({ command }) => getSlashCommandGroup(command) === group),
    group,
  })).filter(({ entries: groupEntries }) => groupEntries.length > 0);
  const isScrollable = slashCommandMenuHeight(entries, descriptionWidth) > maximumRows;

  return (
    <Box
      flexDirection="column"
      height={isScrollable ? maximumRows : undefined}
      marginBottom={LAYOUT_SPACING.compact}
      overflowY="hidden"
    >
      {groups.map(({ count, entries: groupEntries, group }) => (
        <SlashCommandMenuGroup
          count={count}
          entries={groupEntries}
          group={group}
          key={group}
          selectedIndex={selectedIndex}
        />
      ))}
    </Box>
  );
}

function SlashCommandMenuGroup({
  count,
  entries,
  group,
  selectedIndex,
}: {
  readonly count: number;
  readonly entries: readonly {
    readonly command: SlashCommand;
    readonly index: number;
  }[];
  readonly group: SlashCommandGroup;
  readonly selectedIndex: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color={SLASH_COMMAND_GROUP_COLORS[group]}>
        {group} ({count})
      </Text>
      {entries.map(({ command, index }) => (
        <SlashCommandMenuItem
          command={command}
          key={`${command.source ?? "builtin"}:${command.name}`}
          selected={index === selectedIndex}
        />
      ))}
    </Box>
  );
}

function SlashCommandMenuItem({
  command,
  selected,
}: {
  readonly command: SlashCommand;
  readonly selected: boolean;
}) {
  const commandColor = command.source === "agent" || command.source === "skill" ? "green" : "gray";
  const skillHint = command.source === "skill";

  return (
    <Box
      maxHeight={skillHint ? SKILL_HINT_MAX_ROWS : undefined}
      overflowY={skillHint ? "hidden" : undefined}
      width="100%"
    >
      <Box flexShrink={0} width={SLASH_COMMAND_NAME_WIDTH}>
        <Text color={selected ? "yellow" : commandColor}>{formatSlashCommandName(command)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={selected ? "yellow" : "gray"}>{command.description}</Text>
      </Box>
    </Box>
  );
}

interface SlashCommandMenuEntry {
  readonly command: SlashCommand;
  readonly index: number;
}

function slashCommandMenuWindow(
  entries: readonly SlashCommandMenuEntry[],
  selectedIndex: number,
  maximumRows: number,
  descriptionWidth: number,
): readonly SlashCommandMenuEntry[] {
  if (slashCommandMenuHeight(entries, descriptionWidth) <= maximumRows) {
    return entries;
  }

  const focus = Math.max(
    0,
    entries.findIndex((entry) => entry.index === selectedIndex),
  );
  let bestStart = focus;
  let bestEnd = focus + 1;
  let bestHeight = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let start = 0; start <= focus; start += 1) {
    for (let end = focus + 1; end <= entries.length; end += 1) {
      const height = slashCommandMenuHeight(entries.slice(start, end), descriptionWidth);
      if (height > maximumRows) {
        break;
      }
      const distance = Math.abs((start + end - 1) / 2 - focus);
      if (height > bestHeight || (height === bestHeight && distance < bestDistance)) {
        bestStart = start;
        bestEnd = end;
        bestHeight = height;
        bestDistance = distance;
      }
    }
  }

  return entries.slice(bestStart, bestEnd);
}

function slashCommandMenuHeight(
  entries: readonly SlashCommandMenuEntry[],
  descriptionWidth: number,
): number {
  let height = 0;
  let previousGroup: SlashCommandGroup | undefined;

  for (const { command } of entries) {
    const group = getSlashCommandGroup(command);
    if (group !== previousGroup) {
      height += 1;
      previousGroup = group;
    }
    const entryRows = Math.max(
      wrappedTextRows(formatSlashCommandName(command), SLASH_COMMAND_NAME_WIDTH),
      wrappedTextRows(command.description, descriptionWidth),
    );
    height += command.source === "skill" ? Math.min(SKILL_HINT_MAX_ROWS, entryRows) : entryRows;
  }

  return height;
}

function wrappedTextRows(text: string, width: number): number {
  return text
    .split("\n")
    .reduce((rows, line) => rows + wrappedLineRows(line, Math.max(1, width)), 0);
}

function wrappedLineRows(line: string, width: number): number {
  const words = line.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return 1;
  }

  let rows = 1;
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = stringWidth(word);
    const separatorWidth = currentWidth === 0 ? 0 : 1;
    if (currentWidth > 0 && currentWidth + separatorWidth + wordWidth > width) {
      rows += 1;
      currentWidth = 0;
    }
    if (wordWidth > width) {
      rows += Math.floor((wordWidth - 1) / width);
      currentWidth = ((wordWidth - 1) % width) + 1;
    } else {
      currentWidth += (currentWidth === 0 ? 0 : separatorWidth) + wordWidth;
    }
  }

  return rows;
}

export function FileCompletionMenu({
  entries,
  selectedIndex,
}: {
  readonly entries: readonly FileEntry[];
  readonly selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.compact}>
      {entries.map((entry, index) => (
        <Box key={entry.insertValue}>
          <Text color={index === selectedIndex ? "cyan" : "gray"}>
            {entry.isDirectory ? "▸ " : "  "}
            {entry.display}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

const DEFAULT_STATUS_BAR_TEXT =
  "! shell mode • / command mode • @ file search • ⇧⏎ / \\⏎ / Ctrl+J new line";

export function StatusBar({
  contextTokens,
  contextWindow,
  message,
  model,
  showShortcuts = true,
}: {
  readonly contextTokens: number;
  readonly contextWindow?: number | undefined;
  readonly message?: string | undefined;
  readonly model: string;
  readonly showShortcuts?: boolean | undefined;
}) {
  const contextProgress =
    contextWindow !== undefined && contextWindow > 0
      ? Math.min(100, Math.max(0, contextTokens / contextWindow) * 100)
      : undefined;
  const statusText = message ?? (showShortcuts ? DEFAULT_STATUS_BAR_TEXT : undefined);

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.compact} paddingX={1.5}>
      {statusText === undefined ? null : (
        <Text color="gray" wrap="truncate">
          {statusText}
        </Text>
      )}
      <Box justifyContent="flex-end" width="100%">
        <Text color="gray" wrap="truncate">
          Model: <Text color="yellow">{model}</Text>
        </Text>
      </Box>
      <Box justifyContent="flex-end" width="100%">
        <Text color="gray">Context: </Text>
        {contextProgress === undefined ? (
          <Text color="gray">unavailable</Text>
        ) : (
          <>
            <Box flexShrink={0} width={20}>
              <ProgressBar value={contextProgress} />
            </Box>
            <Text color="gray" wrap="truncate">
              {" "}
              {formatPromptContextUsage(contextTokens, contextWindow)}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function formatSlashCommandName(command: SlashCommand): string {
  const aliasesText = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";

  return `/${command.name}${aliasesText}`;
}
