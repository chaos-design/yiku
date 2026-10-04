import type { AgentMessageEnvelope } from "@yiku/agent-orchestrator";
import type { ContextUsageDetails, SessionSummary } from "./session-metrics.js";

export type MessageRole = "assistant" | "command" | "system" | "user";
export type MessageColor = "cyan" | "gray" | "green" | "magenta" | "red" | "white" | "yellow";

export interface MessageContent {
  readonly detailColors?: readonly MessageColor[] | undefined;
  readonly details?: readonly string[] | undefined;
  readonly text: string;
}

export interface SessionMessage {
  readonly contextUsage?: ContextUsageDetails | undefined;
  readonly id: number;
  readonly lineColors?: readonly MessageColor[] | undefined;
  readonly lineIndents?: readonly number[] | undefined;
  readonly role: MessageRole;
  readonly text: string;
  readonly title?: string | undefined;
  readonly tone?: "default" | "error" | undefined;
}

export interface ActiveCommand {
  readonly executionId: number;
  readonly label: string;
  readonly startedAtMs: number;
}

export interface TimelineHeaderItem {
  readonly id: string;
  readonly kind: "header";
  readonly model: string;
  readonly workspaceDir: string;
}

export interface TimelineMessageItem {
  readonly id: string;
  readonly kind: "message";
  readonly message: SessionMessage;
}

export interface TimelineSummaryItem {
  readonly durationSeconds: number;
  readonly id: string;
  readonly kind: "summary";
}

export interface TimelineSessionSummaryItem {
  readonly id: string;
  readonly kind: "session-summary";
  readonly summary: SessionSummary;
}

export interface TimelineRuntimeItem {
  readonly content: MessageContent;
  readonly id: string;
  readonly kind: "runtime";
}

export interface TimelineAgentItem {
  readonly agent: AgentTimelineState;
  readonly id: string;
  readonly kind: "agent";
}

export interface TimelineToolItem {
  readonly call: MessageContent;
  readonly callId?: string | undefined;
  readonly id: string;
  readonly input?: unknown;
  readonly kind: "tool";
  readonly output?: unknown;
  readonly result?: MessageContent | undefined;
  readonly toolName: string;
}

export type TimelineItem =
  | TimelineAgentItem
  | TimelineHeaderItem
  | TimelineMessageItem
  | TimelineRuntimeItem
  | TimelineSessionSummaryItem
  | TimelineSummaryItem
  | TimelineToolItem;

export type AgentTimelineStatus = "cancelled" | "failed" | "running" | "succeeded";

export interface AgentTimelineState {
  readonly activeAssistant?: SessionMessage | undefined;
  readonly activeTool?: TimelineToolItem | undefined;
  readonly agentId: string;
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentSessionId?: string | undefined;
  readonly agentType?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly items: readonly TimelineItem[];
  readonly parentToolCallId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly profileId?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly status: AgentTimelineStatus;
  readonly taskId?: string | undefined;
}

export interface RuntimeTimelineState {
  readonly agents: ReadonlyMap<string, AgentTimelineState>;
  readonly root: AgentTimelineState;
}

export interface AgentMessageSource {
  subscribe(listener: (message: AgentMessageEnvelope) => void): () => void;
}

export type SessionStatus =
  | {
      readonly kind: "idle";
    }
  | {
      readonly kind: "processing";
      readonly prompt: string;
      readonly responseBytes: number;
      readonly startedAtMs: number;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly source?: string | undefined;
    };
