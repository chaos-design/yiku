import type { AgentInputItem, Runner, RunState, Tool } from "@openai/agents";
import type { ToolEffect, UserQuestionRequest } from "@yiku/agent-code";
import type { AtomicFlowRun, AtomicFlowSnapshot } from "@yiku/atomic-flow";
import type { MemoryOperationEvent } from "@yiku/memories";
import type { OperationEvent, Trajectory } from "@yiku/trajectory";
import type { Hook } from "../hooks/types.js";
import type { PromptRiskFinding } from "../prompt/types.js";
import type { SkillSource } from "../skills/skill-types.js";
import type { Skill } from "../skills/types.js";

export type OpenAIAgent = Parameters<Runner["run"]>[0];
export type AgentContinuationState = RunState<unknown, OpenAIAgent>;
export type AgentStopReason =
  | "cancelled"
  | "completed"
  | "max_turns"
  | "provider_error"
  | "timeout";

export interface AgentRuntimeIdentity {
  readonly agentId: string;
  readonly agentKey?: string | undefined;
  readonly agentName: string;
  readonly agentType: string;
}

export interface AgentRunValidation {
  readonly details?: unknown;
  readonly diagnostics: readonly string[];
  readonly passed: boolean;
}

export interface AgentUsage {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly peakInputTokens: number;
  readonly totalTokens: number;
}

export type MemoryOperationProgressEvent = MemoryOperationEvent & {
  readonly type: "memory_operation";
};

export type AgentProgressEvent =
  | {
      readonly attempts: number;
      readonly counts: Readonly<Record<"error" | "failed" | "not-run" | "passed", number>>;
      readonly decision: "accepted" | "degraded" | "needs-review" | "rejected";
      readonly failedChecks: readonly {
        readonly id: string;
        readonly status: "error" | "failed" | "not-run";
        readonly summary: string;
      }[];
      readonly grade: "A" | "B" | "C" | "D" | "S";
      readonly overallScore: number;
      readonly type: "evaluation_finished";
    }
  | {
      readonly checkpointRevision: number;
      readonly sessionStatus: "active" | "completed" | "failed" | "needs-review" | "paused";
      readonly stageId: string;
      readonly type: "checkpoint_saved";
    }
  | {
      readonly afterEntries: number;
      readonly beforeEntries: number;
      readonly type: "context_compacted";
    }
  | {
      readonly findings: readonly PromptRiskFinding[];
      readonly type: "prompt_risk_detected";
    }
  | {
      readonly continuation?: "reconstructed-continuation" | "review-required" | undefined;
      readonly inFlightOperations: number;
      readonly pendingInputIds?: readonly string[] | undefined;
      readonly sessionId: string;
      readonly type: "session_resumed";
    }
  | {
      readonly stage: number;
      readonly stageId: string;
      readonly totalStages: number;
      readonly type: "stage_started";
    }
  | {
      readonly outcome: "completed" | "continued" | "failed" | "paused";
      readonly reason?: string | undefined;
      readonly stageId: string;
      readonly type: "stage_finished";
    }
  | {
      readonly blocked: number;
      readonly completed: number;
      readonly inProgress: number;
      readonly pending: number;
      readonly type: "task_snapshot";
    }
  | {
      readonly action: "cancelled" | "created" | "removed";
      readonly agentType: string;
      readonly profileId: string;
      readonly type: "agent_profile_changed";
    }
  | {
      readonly agentId: string;
      readonly agentKey?: string | undefined;
      readonly agentName?: string | undefined;
      readonly agentSessionId?: string | undefined;
      readonly agentType: string;
      readonly parentAgentId?: string | undefined;
      readonly parentSessionId?: string | undefined;
      readonly parentToolCallId?: string | undefined;
      readonly profileId: string;
      readonly prompt?: string | undefined;
      readonly taskId: string;
      readonly type: "subagent_spawned";
    }
  | {
      readonly agentId: string;
      readonly agentName?: string | undefined;
      readonly agentSessionId?: string | undefined;
      readonly output: string;
      readonly profileId: string;
      readonly taskId: string;
      readonly type: "subagent_output";
    }
  | {
      readonly agentId: string;
      readonly agentName?: string | undefined;
      readonly agentSessionId?: string | undefined;
      readonly error?: string | undefined;
      readonly profileId: string;
      readonly status: "cancelled" | "failed" | "succeeded";
      readonly taskId: string;
      readonly type: "subagent_result";
    }
  | {
      readonly digest: string;
      readonly name: string;
      readonly source: SkillSource;
      readonly type: "skill_resolved";
    }
  | {
      readonly name: string;
      readonly targetId: string;
      readonly type: "skill_activated";
    }
  | {
      readonly name: string;
      readonly type: "skill_worker_started";
      readonly workerId: string;
    }
  | {
      readonly name: string;
      readonly status: "failed" | "succeeded";
      readonly type: "skill_worker_finished";
      readonly workerId: string;
    }
  | {
      readonly agentName: string;
      readonly model: string;
      readonly prompt: string;
      readonly sessionId: string;
      readonly startedAt: string;
      readonly type: "session_started";
      readonly workspaceDir: string;
    }
  | {
      readonly questionId: string;
      readonly request: UserQuestionRequest;
      readonly type: "user_question_requested";
    }
  | {
      readonly questionId: string;
      readonly selectedIndex?: number | undefined;
      readonly type: "user_question_resolved";
    }
  | {
      readonly questionId: string;
      readonly reason: string;
      readonly type: "user_question_cancelled";
    }
  | {
      readonly text: string;
      readonly type: "message_delta";
    }
  | MemoryOperationProgressEvent
  | {
      readonly from: string;
      readonly reason: string;
      readonly to: string;
      readonly type: "runtime_boundary_changed";
    }
  | {
      readonly callId?: string | undefined;
      readonly effect?: ToolEffect | undefined;
      readonly input?: unknown;
      readonly summary: string;
      readonly title: string;
      readonly toolName: string;
      readonly type: "tool_called";
    }
  | {
      readonly callId?: string | undefined;
      readonly effect?: ToolEffect | undefined;
      readonly output?: unknown;
      readonly summary: string;
      readonly title: string;
      readonly toolName: string;
      readonly type: "tool_output";
    }
  | {
      readonly type: "reasoning";
    }
  | {
      readonly agentId?: string | undefined;
      readonly agentName: string;
      readonly type: "agent_updated";
    }
  | {
      readonly sourceAgentName?: string | undefined;
      readonly targetAgentName: string;
      readonly type: "handoff";
    }
  | {
      readonly model: string;
      readonly type: "usage_updated";
      readonly usage: AgentUsage;
    }
  | {
      readonly durationMs: number;
      readonly finishedAt: string;
      readonly reason: string;
      readonly sessionId: string;
      readonly type: "session_cancelled";
    }
  | {
      readonly durationMs: number;
      readonly finishedAt: string;
      readonly output: string;
      readonly sessionId: string;
      readonly type: "session_finished";
    }
  | {
      readonly durationMs: number;
      readonly error: string;
      readonly finishedAt: string;
      readonly sessionId: string;
      readonly source?: string | undefined;
      readonly stack?: string | undefined;
      readonly type: "session_failed";
    };

export type AgentProgressHandler = (event: AgentProgressEvent) => void;

export interface AgentRunResult {
  readonly atomicFlow?: AtomicFlowSnapshot | undefined;
  readonly continuationState?: AgentContinuationState | undefined;
  readonly finalOutput?: unknown;
  readonly outputValidation?: AgentRunValidation | undefined;
  readonly stopReason?: AgentStopReason | undefined;
  readonly trajectory?: Trajectory | undefined;
  readonly usage?: AgentUsage | undefined;
}

export interface AgentRunnerInput {
  readonly agent: OpenAIAgent;
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly beforeModelCall?: (() => Promise<void>) | undefined;
  readonly continuationState?: AgentContinuationState | undefined;
  /** @deprecated The OpenAI runner no longer executes Operation Hooks. */
  readonly hooks?: readonly Hook[] | undefined;
  readonly maxTurns?: number | undefined;
  readonly model: string;
  readonly onEvent?: AgentProgressHandler | undefined;
  readonly prompt: RunInput;
  readonly resolveAgentIdentity?:
    | ((agent: OpenAIAgent) => AgentRuntimeIdentity | undefined)
    | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type AgentRunner = (input: AgentRunnerInput) => Promise<AgentRunResult>;

export interface RunnerAdapter {
  readonly run: Runner["run"];
}

export interface CreateOpenAIAgentRunnerOptions {
  readonly createRunner?:
    | ((apiKey: string, baseURL?: string | undefined) => RunnerAdapter)
    | undefined;
}

export interface RunOptions {
  readonly apiKey: string;
  readonly atomicEntryInstanceId?: string | undefined;
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly baseURL?: string | undefined;
  readonly beforeModelCall?: (() => Promise<void>) | undefined;
  readonly continuationState?: AgentContinuationState | undefined;
  /** @deprecated Use AgentSession HookEngine configuration. */
  readonly hooks?: readonly Hook[] | undefined;
  readonly maxTurns?: number | undefined;
  readonly model: string;
  readonly onEvent?: AgentProgressHandler | undefined;
  readonly runner?: AgentRunner | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly skills?: readonly Skill[] | undefined;
  readonly tools?: readonly Tool[] | undefined;
}

export type RunInput = string | AgentInputItem[];

export type RuntimeEvent = AgentProgressEvent | OperationEvent;
