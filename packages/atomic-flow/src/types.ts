export type AtomicKind =
  | "action"
  | "agent"
  | "context"
  | "eval"
  | "handoff"
  | "hook"
  | "input"
  | "loop"
  | "memory"
  | "model"
  | "release"
  | "reply"
  | "skill"
  | "store"
  | "tool"
  | "trace"
  | "trajectory"
  | "usage";

export type AtomicLevel = "deep" | "runtime";
export type AtomicPhase = "delta" | "end" | "error" | "scheduled" | "skipped" | "start";
export type AtomicStatus = "completed" | "failed" | "running" | "scheduled" | "skipped";
export type AtomicEdgeKind = "data" | "execution" | "feedback" | "persistence";
export type AtomicValue =
  | boolean
  | null
  | number
  | string
  | readonly AtomicValue[]
  | { readonly [key: string]: AtomicValue };

export interface AtomicDefinition {
  readonly key: string;
  readonly kind: AtomicKind;
  readonly label: string;
  readonly level: AtomicLevel;
}

export interface AtomicInstance {
  readonly id: string;
  readonly iteration?: number | undefined;
  readonly parentId?: string | undefined;
}

export interface AtomicEdge {
  readonly fromAtomKey: string;
  readonly fromInstanceId?: string | undefined;
  readonly kind: AtomicEdgeKind;
  readonly toAtomKey: string;
}

export interface AtomicPayloadSummary {
  readonly code?: string | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly durationMs?: number | undefined;
  readonly summary?: string | undefined;
  readonly title?: string | undefined;
  readonly values?: Readonly<Record<string, AtomicValue>> | undefined;
}

export interface AtomicFlowEvent {
  readonly atom: AtomicDefinition;
  readonly edge?: AtomicEdge | undefined;
  readonly eventId: string;
  readonly instance: AtomicInstance;
  readonly internal?: boolean | undefined;
  readonly occurredAt: string;
  readonly payload?: AtomicPayloadSummary | undefined;
  readonly phase: AtomicPhase;
  readonly runId: string;
  readonly sequence: number;
}

export interface AtomicEventDraft {
  readonly atom: AtomicDefinition;
  readonly edge?: AtomicEdge | undefined;
  readonly instance: AtomicInstance;
  readonly internal?: boolean | undefined;
  readonly payload?: AtomicPayloadSummary | undefined;
  readonly phase: AtomicPhase;
}

export interface AtomicSpanInput {
  readonly atom: AtomicDefinition;
  readonly edge?: AtomicEdge | undefined;
  readonly instanceId?: string | undefined;
  readonly iteration?: number | undefined;
  readonly parentInstanceId?: string | undefined;
  readonly payload?: AtomicPayloadSummary | undefined;
}

export interface AtomicSinkReceiptDraft {
  readonly atom: AtomicDefinition;
  readonly payload?: AtomicPayloadSummary | undefined;
  readonly phase?: AtomicPhase | undefined;
}

export interface AtomicFlowSink {
  readonly durable?: boolean | undefined;
  readonly id: string;
  write(
    event: AtomicFlowEvent,
  ): Promise<AtomicSinkReceiptDraft | undefined> | AtomicSinkReceiptDraft | undefined;
  close?(): Promise<void> | void;
}

export type AtomicFlowSubscriber = (event: AtomicFlowEvent) => void;

export interface AtomicFlowRunOptions {
  readonly clock?: (() => Date) | undefined;
  readonly eventIdGenerator?: (() => string) | undefined;
  readonly instanceIdGenerator?: (() => string) | undefined;
  readonly maxBufferedEvents?: number | undefined;
  readonly runId: string;
  readonly sinks?: readonly AtomicFlowSink[] | undefined;
  readonly trace?: boolean | undefined;
}

export interface AtomicFlowSnapshot {
  readonly degraded: boolean;
  readonly degradationCodes: readonly string[];
  readonly events: readonly AtomicFlowEvent[];
  readonly runId: string;
}

export interface AtomicInstanceState {
  readonly atom: AtomicDefinition;
  readonly endedAt?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly id: string;
  readonly iteration?: number | undefined;
  readonly lastSequence: number;
  readonly parentId?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly status: AtomicStatus;
}

export interface AtomicFoldState {
  readonly edges: ReadonlyMap<string, AtomicEdge>;
  readonly instances: ReadonlyMap<string, AtomicInstanceState>;
  readonly latestSequence: number;
  readonly runId?: string | undefined;
}

export interface AtomicJsonlSinkOptions {
  readonly filePath: string;
  readonly includeReceipts?: boolean | undefined;
}

export interface AtomicStudioProject {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
}

export interface AtomicStudioRunMetadata {
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentType?: string | undefined;
  readonly kind?: "agent" | "control" | undefined;
  readonly prompt?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface AtomicStudioSinkOptions {
  readonly endpoint: string;
  readonly project?: AtomicStudioProject | undefined;
  readonly request?: typeof fetch | undefined;
  readonly run?: AtomicStudioRunMetadata | undefined;
}

export interface ReadAtomicEventsOptions {
  readonly afterSequence?: number | undefined;
}
