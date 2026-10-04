import type { SessionState } from "@yiku/agent-orchestrator";
import { Box, Text } from "ink";
import { LAYOUT_SPACING } from "./constants.js";
import { MarkdownMessage } from "./markdown.js";
import { formatDuration } from "./session-metrics.js";
import { ToolBlockView } from "./tool-view.js";
import type {
  AgentTimelineState,
  AgentTimelineStatus,
  MessageColor,
  SessionMessage,
  TimelineItem,
} from "./types.js";

const LIVE_AGENT_ITEM_LIMIT = 8;
const LIVE_MARKDOWN_CHARACTER_LIMIT = 4_000;

export function SubagentBlockView({
  agent,
  outputStyle = "default",
}: {
  readonly agent: AgentTimelineState;
  readonly outputStyle?: SessionState["outputStyle"] | undefined;
}) {
  const detail = agent.prompt?.trim() || agent.taskId?.trim();
  const agentType = agent.agentType?.trim() || "unknown";
  const agentName =
    agent.agentName?.trim() ||
    agent.profileId?.trim() ||
    agent.agentKey?.trim() ||
    agent.agentType?.trim() ||
    "subagent";
  const agentSessionId = agent.agentSessionId?.trim();
  const profileId = agent.profileId?.trim();
  const identity = [
    `Type: ${agentType}`,
    ...(profileId !== undefined && profileId.toLowerCase() !== agentName.toLowerCase()
      ? [`Profile: ${profileId}`]
      : []),
    ...(agentSessionId ? [`Session: ${shortSessionId(agentSessionId)}`] : []),
  ].join(" · ");
  const presentation = statusPresentation(agent.status);
  const duration = completedDuration(agent);
  const showDetails = outputStyle !== "compact" || agent.status === "running";
  const visibleItems =
    agent.status === "running" ? agent.items.slice(-LIVE_AGENT_ITEM_LIMIT) : agent.items;
  const hiddenItemCount = agent.items.length - visibleItems.length;

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.item}>
      <Text>
        <Text color={presentation.color}>{presentation.marker} </Text>
        <Text bold color="white">
          Agent({summarizeLabel(agentName)})
        </Text>
        {agent.status === "running" ? <Text color="gray"> running</Text> : null}
      </Text>
      <Box marginLeft={2}>
        <Text color="gray">{identity}</Text>
      </Box>
      {detail ? (
        <Box marginLeft={2}>
          <Text color="gray">Task: {summarizeDetail(detail)}</Text>
        </Box>
      ) : null}
      {showDetails && hiddenItemCount > 0 ? (
        <Box marginLeft={2}>
          <Text color="gray">├ ... {hiddenItemCount} earlier event(s)</Text>
        </Box>
      ) : null}
      {showDetails
        ? visibleItems.map((item) => (
            <SubagentTimelineItem item={item} key={item.id} outputStyle={outputStyle} />
          ))
        : null}
      {showDetails && agent.activeAssistant ? (
        <SubagentMessage live message={agent.activeAssistant} prefix="└ " />
      ) : null}
      {showDetails && agent.activeTool ? (
        <ToolBlockView indent={2} item={agent.activeTool} outputStyle={outputStyle} prefix="└ " />
      ) : null}
      {agent.status === "running" ? null : (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={presentation.color}>
            └ {presentation.label}
            {duration ? ` in ${duration}` : ""}
          </Text>
          {agent.error ? (
            <Text color="red">
              {"  "}Reason: {summarizeDetail(agent.error)}
            </Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

function shortSessionId(value: string): string {
  return value.length <= 20 ? value : `...${value.slice(-12)}`;
}

function summarizeDetail(value: string): string {
  const singleLine = value.replaceAll(/\s+/gu, " ").trim();
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 157)}...`;
}

function summarizeLabel(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function SubagentTimelineItem({
  item,
  outputStyle,
}: {
  readonly item: TimelineItem;
  readonly outputStyle: SessionState["outputStyle"];
}) {
  switch (item.kind) {
    case "agent":
      return (
        <Box marginLeft={2}>
          <SubagentBlockView agent={item.agent} outputStyle={outputStyle} />
        </Box>
      );
    case "message":
      return <SubagentMessage message={item.message} prefix="├ " />;
    case "tool":
      return <ToolBlockView indent={2} item={item} outputStyle={outputStyle} prefix="├ " />;
    case "runtime":
      return (
        <Box marginLeft={2}>
          <Text color="gray">├ {item.content.text}</Text>
        </Box>
      );
    case "summary":
      return (
        <Box marginLeft={2}>
          <Text color="gray">├ Thought for {item.durationSeconds}s</Text>
        </Box>
      );
    case "header":
    case "session-summary":
      return null;
  }
}

function SubagentMessage({
  live = false,
  message,
  prefix,
}: {
  readonly live?: boolean | undefined;
  readonly message: SessionMessage;
  readonly prefix: string;
}) {
  const text = live ? liveMarkdownPreview(message.text) : message.text;
  return (
    <Box flexDirection="row" marginBottom={LAYOUT_SPACING.item} marginLeft={2}>
      <Text color="gray">{prefix}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <MarkdownMessage text={text} />
      </Box>
    </Box>
  );
}

function liveMarkdownPreview(text: string): string {
  if (text.length <= LIVE_MARKDOWN_CHARACTER_LIMIT) {
    return text;
  }
  const tail = text.slice(-LIVE_MARKDOWN_CHARACTER_LIMIT);
  const firstLineBreak = tail.indexOf("\n");
  return `_[Earlier output hidden while Agent is running]_\n\n${
    firstLineBreak === -1 ? tail : tail.slice(firstLineBreak + 1)
  }`;
}

function completedDuration(agent: AgentTimelineState): string | undefined {
  if (agent.startedAt === undefined || agent.completedAt === undefined) {
    return undefined;
  }

  const startedAtMs = Date.parse(agent.startedAt);
  const completedAtMs = Date.parse(agent.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return undefined;
  }

  return formatDuration(Math.max(0, completedAtMs - startedAtMs));
}

function statusPresentation(status: AgentTimelineStatus): {
  readonly color: MessageColor;
  readonly label: string;
  readonly marker: string;
} {
  switch (status) {
    case "cancelled":
      return { color: "yellow", label: "Cancelled", marker: "○" };
    case "failed":
      return { color: "red", label: "Failed", marker: "●" };
    case "running":
      return { color: "cyan", label: "Running", marker: "◆" };
    case "succeeded":
      return { color: "green", label: "Succeeded", marker: "●" };
  }
}
