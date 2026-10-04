import type { AtomicFlowEvent } from "@yiku/atomic-flow";

export type EvalMode = "async" | "blocking";
export type StudioRunSource = "external" | "studio";

export type StudioRunStatus =
  | "accepted"
  | "cancelled"
  | "completed"
  | "degraded"
  | "evaluating"
  | "failed"
  | "needs-review"
  | "queued"
  | "rejected"
  | "running";

export interface AgentSessionSummary {
  readonly agentId: string;
  readonly agentName: string;
  readonly agentSessionId: string;
  readonly agentType: string;
  readonly parentSessionId: string;
  readonly status: "cancelled" | "failed" | "running" | "succeeded";
  readonly taskId: string;
}

export interface StudioRunSummary {
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentSessions?: readonly AgentSessionSummary[] | undefined;
  readonly agentType?: string | undefined;
  readonly createdAt: string;
  readonly evalMode: EvalMode;
  readonly eventCount: number;
  readonly kind?: "agent" | "control" | undefined;
  readonly projectName?: string | undefined;
  readonly prompt: string;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly source: StudioRunSource;
  readonly status: StudioRunStatus;
  readonly updatedAt: string;
}

export interface StudioRunDetail extends StudioRunSummary {
  readonly error?: string | undefined;
  readonly events: readonly AtomicFlowEvent[];
  readonly output?: string | undefined;
  readonly scorecard?: EvalScorecard | undefined;
}

export interface StoredRunMetadata {
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentSessions?: readonly AgentSessionSummary[] | undefined;
  readonly agentType?: string | undefined;
  readonly createdAt: string;
  readonly error?: string | undefined;
  readonly evalMode: EvalMode;
  readonly kind?: "agent" | "control" | undefined;
  readonly output?: string | undefined;
  readonly projectId?: string | undefined;
  readonly projectName?: string | undefined;
  readonly prompt: string;
  readonly runId: string;
  readonly scorecard?: EvalScorecard | undefined;
  readonly sessionId?: string | undefined;
  readonly source?: StudioRunSource | undefined;
  readonly status: StudioRunStatus;
  readonly updatedAt: string;
  readonly workspaceDir: string;
}

export interface IngestEventInput {
  readonly event: AtomicFlowEvent;
  readonly project?: {
    readonly id?: string | undefined;
    readonly name?: string | undefined;
  };
  readonly run?: {
    readonly agentKey?: string | undefined;
    readonly agentName?: string | undefined;
    readonly agentType?: string | undefined;
    readonly kind?: "agent" | "control" | undefined;
    readonly prompt?: string | undefined;
    readonly sessionId?: string | undefined;
  };
}

export interface IngestEventResult {
  readonly duplicate: boolean;
  readonly expectedSequence: number;
  readonly runId: string;
}

export interface EvalScorecard {
  readonly averageScore: number;
  readonly attemptId?: string | undefined;
  readonly counts?: Readonly<Record<"error" | "failed" | "not-run" | "passed", number>> | undefined;
  readonly decision?: string | undefined;
  readonly dimensionScores?:
    | Readonly<
        Record<"correctness" | "performance" | "resource-efficiency" | "safety-reliability", number>
      >
    | undefined;
  readonly grade?: "A" | "B" | "C" | "D" | "S" | undefined;
  readonly overallScore?: number | undefined;
  readonly passed: boolean;
  readonly results: readonly {
    readonly errorCode?: string | undefined;
    readonly key: string;
    readonly label: string;
    readonly passed: boolean;
    readonly score: number;
    readonly status?: "error" | "failed" | "not-run" | "passed" | undefined;
    readonly summary: string;
  }[];
}
