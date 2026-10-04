import type { AtomicKind } from "@yiku/atomic-flow";

export type OperationKind =
  | "agent"
  | "handoff"
  | "hook"
  | "model"
  | "run"
  | "skill"
  | "tool"
  | "usage";
export type OperationPhase = "delta" | "end" | "error" | "start";
export type OperationStatus = "completed" | "failed" | "running";

export interface OperationEvent {
  readonly endedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly input?: unknown;
  readonly kind: OperationKind;
  readonly name: string;
  readonly operationId: string;
  readonly output?: unknown;
  readonly parentId?: string | undefined;
  readonly phase: OperationPhase;
  readonly startedAt: string;
  readonly status: OperationStatus;
}

export interface TrajectoryStep {
  readonly atomKey?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly id: string;
  readonly input?: unknown;
  readonly iteration?: number | undefined;
  readonly kind: AtomicKind | OperationKind;
  readonly name: string;
  readonly output?: unknown;
  readonly parentId?: string | undefined;
  readonly startedAt: string;
  readonly status: OperationStatus;
}

export interface Trajectory {
  readonly endedAt?: string | undefined;
  readonly id: string;
  readonly startedAt: string;
  readonly steps: readonly TrajectoryStep[];
}

export interface TraceEntry<TEvent = unknown> {
  readonly event: TEvent;
  readonly recordedAt: string;
  readonly result?: unknown;
  readonly step: number;
}

export type TraceResultResolver<TEvent = unknown> = (event: TEvent) => unknown;

export interface TraceOptions<TEvent = unknown> {
  readonly getResult?: TraceResultResolver<TEvent> | undefined;
}

export interface TrajectoryRenderOptions {
  readonly includeRawValues?: boolean | undefined;
}

export interface ProjectTrajectoryOptions {
  readonly runId?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly throughSequence?: number | undefined;
}

export type TrajectorySubscriber = (trajectory: Trajectory) => void;
