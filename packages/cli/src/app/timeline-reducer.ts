import type {
  AgentMessageEnvelope,
  AgentMessagePayload,
  AgentProgressEvent,
} from "@yiku/agent-orchestrator";
import { formatToolCall, formatToolResult } from "./tool-presentation.js";
import type {
  AgentTimelineState,
  AgentTimelineStatus,
  RuntimeTimelineState,
  TimelineItem,
  TimelineMessageItem,
  TimelineToolItem,
} from "./types.js";

type ToolCalledPayload = Extract<AgentMessagePayload, { readonly kind: "tool_called" }>;
type ToolOutputPayload = Extract<AgentMessagePayload, { readonly kind: "tool_output" }>;
type ToolCalledEvent = Extract<AgentProgressEvent, { readonly type: "tool_called" }>;
type ToolOutputEvent = Extract<AgentProgressEvent, { readonly type: "tool_output" }>;

export function createRuntimeTimelineState(
  rootAgentId: string,
  rootItems: readonly TimelineItem[] = [],
): RuntimeTimelineState {
  return {
    agents: new Map(),
    root: {
      agentId: rootAgentId,
      items: rootItems,
      status: "running",
    },
  };
}

export function reduceRuntimeTimeline(
  state: RuntimeTimelineState,
  message: AgentMessageEnvelope,
): RuntimeTimelineState {
  const payload = message.payload;

  switch (payload.kind) {
    case "assistant_delta":
      return updateAgent(state, message, (agent) => appendAssistantDelta(agent, payload.text));
    case "tool_called":
      return updateAgent(state, message, (agent) => startTool(agent, message, payload));
    case "tool_output":
      return updateAgent(state, message, (agent) => finishTool(agent, message, payload));
    case "agent_spawned":
      return updateAgent(state, message, (agent) => ({
        ...agent,
        ...(payload.agentKey !== undefined ? { agentKey: payload.agentKey } : {}),
        ...(payload.agentName !== undefined ? { agentName: payload.agentName } : {}),
        ...(message.agentSessionId !== undefined ? { agentSessionId: message.agentSessionId } : {}),
        agentType: payload.agentType,
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        profileId: payload.profileId,
        startedAt: message.occurredAt,
        status: "running",
      }));
    case "agent_output":
      return updateAgent(state, message, (agent) => appendAgentOutput(agent, payload.text));
    case "agent_finished":
      return updateAgent(state, message, (agent) =>
        completeAgent(agent, payload.status, message.occurredAt, payload.error),
      );
    case "session_lifecycle": {
      const status = readLegacyResultStatus(payload.phase, payload.values);
      return status === undefined
        ? state
        : updateAgent(state, message, (agent) => completeAgent(agent, status, message.occurredAt));
    }
    case "checkpoint":
    case "hook_decision":
    case "memory_operation":
    case "reasoning":
    case "runtime_boundary_changed":
    case "usage":
      return state;
  }
}

function appendAgentOutput(agent: AgentTimelineState, text: string): AgentTimelineState {
  const output = text.trim();
  if (!output) {
    return agent;
  }
  const prepared = commitActiveTool(agent);
  if (prepared.activeAssistant?.text.trim() === output) {
    return commitActiveAssistant(prepared);
  }
  const committed = commitActiveAssistant(prepared);
  const lastItem = committed.items.at(-1);
  if (lastItem?.kind === "message" && lastItem.message.text.trim() === output) {
    return committed;
  }
  const message = {
    id: nextMessageId(committed),
    role: "assistant" as const,
    text,
  };
  return {
    ...committed,
    items: [
      ...committed.items,
      {
        id: `message:${message.id}`,
        kind: "message",
        message,
      },
    ],
  };
}

function appendAssistantDelta(agent: AgentTimelineState, text: string): AgentTimelineState {
  if (agent.activeAssistant !== undefined) {
    return {
      ...agent,
      activeAssistant: {
        ...agent.activeAssistant,
        text: agent.activeAssistant.text + text,
      },
    };
  }

  return {
    ...agent,
    activeAssistant: {
      id: nextMessageId(agent),
      role: "assistant",
      text,
    },
  };
}

function startTool(
  agent: AgentTimelineState,
  message: AgentMessageEnvelope,
  payload: ToolCalledPayload,
): AgentTimelineState {
  const prepared = commitActiveTool(commitActiveAssistant(agent));
  const event = toolCalledEvent(message.toolCallId, payload);

  return {
    ...prepared,
    activeTool: {
      call: formatToolCall(event),
      ...(message.toolCallId !== undefined ? { callId: message.toolCallId } : {}),
      id: `tool:${message.eventId}`,
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      kind: "tool",
      toolName: payload.toolName,
    },
  };
}

function finishTool(
  agent: AgentTimelineState,
  message: AgentMessageEnvelope,
  payload: ToolOutputPayload,
): AgentTimelineState {
  const activeTool = agent.activeTool;

  if (activeTool !== undefined && toolMatches(activeTool, message.toolCallId, payload.toolName)) {
    return {
      ...agent,
      activeTool: undefined,
      items: [
        ...agent.items,
        {
          ...activeTool,
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          result: formatToolResult(toolOutputEvent(message.toolCallId, payload), activeTool.input),
        },
      ],
    };
  }

  const itemIndex = findMatchingToolIndex(agent.items, message.toolCallId, payload.toolName);
  if (itemIndex !== -1) {
    const matchedTool = agent.items[itemIndex] as TimelineToolItem;
    const items = [...agent.items];
    items[itemIndex] = {
      ...matchedTool,
      ...(payload.output !== undefined ? { output: payload.output } : {}),
      result: formatToolResult(toolOutputEvent(message.toolCallId, payload), matchedTool.input),
    };
    return {
      ...agent,
      items,
    };
  }

  return {
    ...agent,
    items: [
      ...agent.items,
      {
        call: { text: payload.title },
        ...(message.toolCallId !== undefined ? { callId: message.toolCallId } : {}),
        id: `tool:${message.eventId}`,
        kind: "tool",
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        result: formatToolResult(toolOutputEvent(message.toolCallId, payload), undefined),
        toolName: payload.toolName,
      },
    ],
  };
}

function completeAgent(
  agent: AgentTimelineState,
  status: Exclude<AgentTimelineStatus, "running">,
  occurredAt: string,
  error?: string,
): AgentTimelineState {
  const completed = commitActiveTool(commitActiveAssistant(agent));
  return {
    ...completed,
    completedAt: occurredAt,
    ...(error !== undefined ? { error } : {}),
    status,
  };
}

function commitActiveAssistant(agent: AgentTimelineState): AgentTimelineState {
  const message = agent.activeAssistant;
  if (message === undefined) {
    return agent;
  }

  if (!message.text.trim()) {
    return {
      ...agent,
      activeAssistant: undefined,
    };
  }

  const item = {
    id: `message:${message.id}`,
    kind: "message",
    message,
  } satisfies TimelineMessageItem;

  return {
    ...agent,
    activeAssistant: undefined,
    items: [...agent.items, item],
  };
}

function commitActiveTool(agent: AgentTimelineState): AgentTimelineState {
  if (agent.activeTool === undefined) {
    return agent;
  }

  return {
    ...agent,
    activeTool: undefined,
    items: [...agent.items, agent.activeTool],
  };
}

function updateAgent(
  state: RuntimeTimelineState,
  message: AgentMessageEnvelope,
  update: (agent: AgentTimelineState) => AgentTimelineState,
): RuntimeTimelineState {
  const isRoot = message.agentId === state.root.agentId;
  const current = isRoot
    ? state.root
    : (state.agents.get(message.agentId) ?? createAgentState(message));
  const correlated = correlateParentTool(current, message.parentToolCallId);
  const next = update(correlated);

  if (isRoot) {
    return next === state.root
      ? state
      : {
          ...state,
          root: next,
        };
  }

  if (next === state.agents.get(message.agentId)) {
    return state;
  }

  const agents = new Map(state.agents);
  agents.set(message.agentId, next);
  return {
    ...state,
    agents,
  };
}

function createAgentState(message: AgentMessageEnvelope): AgentTimelineState {
  return {
    agentId: message.agentId,
    ...(message.agentSessionId !== undefined ? { agentSessionId: message.agentSessionId } : {}),
    items: [],
    ...(message.parentToolCallId !== undefined
      ? { parentToolCallId: message.parentToolCallId }
      : {}),
    status: "running",
  };
}

function correlateParentTool(
  agent: AgentTimelineState,
  parentToolCallId: string | undefined,
): AgentTimelineState {
  if (parentToolCallId === undefined || parentToolCallId === agent.parentToolCallId) {
    return agent;
  }

  return {
    ...agent,
    parentToolCallId,
  };
}

function nextMessageId(agent: AgentTimelineState): number {
  let maximum = 0;

  for (const item of agent.items) {
    if (item.kind === "message") {
      maximum = Math.max(maximum, item.message.id);
    }
  }

  return maximum + 1;
}

function findMatchingToolIndex(
  items: readonly TimelineItem[],
  toolCallId: string | undefined,
  toolName: string,
): number {
  return items.findLastIndex(
    (item) =>
      item.kind === "tool" &&
      toolMatches(item, toolCallId, toolName) &&
      (toolCallId !== undefined || item.result === undefined),
  );
}

function toolMatches(
  tool: TimelineToolItem,
  toolCallId: string | undefined,
  toolName: string,
): boolean {
  return toolCallId !== undefined ? tool.callId === toolCallId : tool.toolName === toolName;
}

function toolCalledEvent(
  toolCallId: string | undefined,
  payload: ToolCalledPayload,
): ToolCalledEvent {
  return {
    ...(toolCallId !== undefined ? { callId: toolCallId } : {}),
    ...(payload.effect !== undefined ? { effect: payload.effect } : {}),
    ...(payload.input !== undefined ? { input: payload.input } : {}),
    summary: payload.summary,
    title: payload.title,
    toolName: payload.toolName,
    type: "tool_called",
  };
}

function toolOutputEvent(
  toolCallId: string | undefined,
  payload: ToolOutputPayload,
): ToolOutputEvent {
  return {
    ...(toolCallId !== undefined ? { callId: toolCallId } : {}),
    ...(payload.effect !== undefined ? { effect: payload.effect } : {}),
    ...(payload.output !== undefined ? { output: payload.output } : {}),
    summary: payload.summary,
    title: payload.title,
    toolName: payload.toolName,
    type: "tool_output",
  };
}

function readLegacyResultStatus(
  phase: string,
  values: unknown,
): Exclude<AgentTimelineStatus, "running"> | undefined {
  if (phase !== "subagent_result" || !isRecord(values)) {
    return undefined;
  }

  const status = values.status;
  return status === "cancelled" || status === "failed" || status === "succeeded"
    ? status
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
