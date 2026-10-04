import type { AgentProgressEvent, AgentStopReason, AgentUsage } from "@yiku/agent-orchestrator";
import type { ResearchEvidence, ResearchReportValidation } from "@yiku/agent-research";
import type { AtomicFlowEvent, AtomicFlowRun } from "@yiku/atomic-flow";

export type ResearchRunStatus = "cancelled" | "completed" | "failed" | "queued" | "running";
export type ResearchThreadStatus = "idle" | ResearchRunStatus;
export type ResearchSkillId = "deep-research" | "quick-research" | "research";
export type ResearchSearchContextSize = "high" | "low" | "medium";

export interface ResearchTurnOptions {
  readonly instructions?: string | undefined;
  readonly searchContextSize?: ResearchSearchContextSize | undefined;
}

export interface ResearchConversationInputMessage {
  readonly content: string;
  readonly role: "assistant" | "user";
}

export interface ResearchMessage extends ResearchConversationInputMessage {
  readonly createdAt: string;
  readonly messageId: string;
  readonly turnId?: string | undefined;
}

export interface RunStatusData {
  readonly error?: string | undefined;
  readonly model?: string | undefined;
  readonly output?: string | undefined;
  readonly status: ResearchRunStatus;
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
      readonly data: AgentProgressEvent;
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
  readonly status: ResearchRunStatus;
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

export interface ResearchExecutionInput {
  readonly atomicFlow: AtomicFlowRun;
  readonly history?: readonly ResearchConversationInputMessage[] | undefined;
  readonly instructions?: string | undefined;
  readonly onEvent: (event: AgentProgressEvent) => void;
  readonly prompt: string;
  readonly searchContextSize?: ResearchSearchContextSize | undefined;
  readonly signal: AbortSignal;
  readonly skill: ResearchSkillId;
}

export interface ResearchExecutionResult {
  readonly evidence?: readonly ResearchEvidence[] | undefined;
  readonly finalOutput?: unknown;
  readonly model: string;
  readonly stopReason?: AgentStopReason | undefined;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: ResearchReportValidation | undefined;
}

export interface ResearchRunExecutor {
  execute(input: ResearchExecutionInput): Promise<ResearchExecutionResult>;
}

export interface ResearchTurnSummary {
  readonly createdAt: string;
  readonly prompt: string;
  readonly skill: ResearchSkillId;
  readonly status: ResearchRunStatus;
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
  readonly status: ResearchThreadStatus;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ResearchThreadSnapshot extends ResearchThreadSummary {
  readonly messages: readonly ResearchMessage[];
  readonly turns: readonly ResearchTurnSnapshot[];
}
