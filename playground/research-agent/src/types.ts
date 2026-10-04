import type { ResearchEvidence, ResearchReportValidation } from "@yiku/agent-research";
import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";

export interface AgentUsage {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly peakInputTokens: number;
  readonly totalTokens: number;
}

export type ResearchRunStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "idle"
  | "queued"
  | "running";

export type ResearchSkillId = "deep-research" | "quick-research" | "research";
export type ResearchSearchContextSize = "high" | "low" | "medium";

export interface ResearchTurnOptions {
  readonly instructions?: string | undefined;
  readonly searchContextSize?: ResearchSearchContextSize | undefined;
}

export interface ProgressEvent {
  readonly agentName?: string | undefined;
  readonly callId?: string | undefined;
  readonly digest?: string | undefined;
  readonly effect?: string | undefined;
  readonly input?: unknown;
  readonly model?: string | undefined;
  readonly name?: string | undefined;
  readonly output?: unknown;
  readonly source?: string | undefined;
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly targetId?: string | undefined;
  readonly text?: string | undefined;
  readonly title?: string | undefined;
  readonly toolName?: string | undefined;
  readonly type: string;
  readonly usage?: AgentUsage | undefined;
  readonly workerId?: string | undefined;
}

export interface RunStatusData {
  readonly error?: string | undefined;
  readonly model?: string | undefined;
  readonly output?: string | undefined;
  readonly status: Exclude<ResearchRunStatus, "idle">;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: ResearchReportValidation | undefined;
}

export type RunStreamEvent =
  | {
      readonly data: AtomicFlowEvent;
      readonly id: number;
      readonly occurredAt: string;
      readonly runId: string;
      readonly type: "flow";
    }
  | {
      readonly data: ProgressEvent;
      readonly id: number;
      readonly occurredAt: string;
      readonly runId: string;
      readonly type: "progress";
    }
  | {
      readonly data: RunStatusData;
      readonly id: number;
      readonly occurredAt: string;
      readonly runId: string;
      readonly type: "status";
    };

export interface ResearchRunSummary {
  readonly createdAt: string;
  readonly prompt: string;
  readonly runId: string;
  readonly status: Exclude<ResearchRunStatus, "idle">;
  readonly updatedAt: string;
}

export interface ResearchRunSnapshot extends ResearchRunSummary {
  readonly error?: string | undefined;
  readonly events: readonly RunStreamEvent[];
  readonly model?: string | undefined;
  readonly output?: string | undefined;
  readonly streamedText: string;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: ResearchReportValidation | undefined;
}

export type ConnectionStatus = "connecting" | "disconnected" | "idle" | "live";

export interface ObservatoryStatus {
  readonly available: boolean;
  readonly url: string;
}

export interface ResearchMessage {
  readonly content: string;
  readonly createdAt: string;
  readonly messageId: string;
  readonly role: "assistant" | "user";
  readonly turnId?: string | undefined;
}

export interface ResearchTurnSummary {
  readonly createdAt: string;
  readonly prompt: string;
  readonly skill: ResearchSkillId;
  readonly status: Exclude<ResearchRunStatus, "idle">;
  readonly threadId: string;
  readonly turnId: string;
  readonly updatedAt: string;
}

export interface ResearchTurnSnapshot extends ResearchTurnSummary {
  readonly error?: string | undefined;
  readonly events: readonly RunStreamEvent[];
  readonly evidence: readonly ResearchEvidence[];
  readonly model?: string | undefined;
  readonly output?: string | undefined;
  readonly streamedText: string;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: ResearchReportValidation | undefined;
}

export interface ResearchThreadSummary {
  readonly createdAt: string;
  readonly lastMessage?: string | undefined;
  readonly messageCount: number;
  readonly status: ResearchRunStatus;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ResearchThreadSnapshot extends ResearchThreadSummary {
  readonly messages: readonly ResearchMessage[];
  readonly turns: readonly ResearchTurnSnapshot[];
}

export type FlowNodeId =
  | "citation-validate"
  | "corroborate"
  | "evidence-record"
  | "plan"
  | "query"
  | "report"
  | "search"
  | "synthesize";

export type FlowNodeStatus = "active" | "completed" | "failed" | "idle";

export interface FlowNodeView {
  readonly executionActive: boolean;
  readonly id: FlowNodeId;
  readonly status: FlowNodeStatus;
}

export interface FlowEdgeView {
  readonly flowing: boolean;
  readonly from: FlowNodeId;
  readonly kind: NonNullable<AtomicFlowEvent["edge"]>["kind"];
  readonly sequence: number;
  readonly status: Exclude<FlowNodeStatus, "idle">;
  readonly to: FlowNodeId;
}
