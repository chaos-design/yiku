import type {
  AtomicFlowRun,
  AtomicPayloadSummary,
  AtomicSpan,
  AtomicValue,
} from "@yiku/atomic-flow";
import type { HookEventHandler, HookOperationEvent } from "@yiku/hooks";
import type { OperationEvent, TrajectoryRecorder } from "@yiku/trajectory";
import { hookAtom } from "../runtime/atoms.js";

export interface HookAuditOptions {
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly maxEntries?: number | undefined;
  readonly parentInstanceId?: string | undefined;
  readonly sink?: HookEventHandler | undefined;
  readonly trajectory?: TrajectoryRecorder | undefined;
}

export class HookAudit {
  public readonly handle: HookEventHandler = (event) => {
    const sanitized = sanitizeEvent(event);
    this.entries.push(sanitized);

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.recordAtomic(sanitized);
    this.trajectory?.record(toOperationEvent(sanitized, this.parentInstanceId));
    this.sink?.(sanitized);
  };

  private readonly atomicFlow?: AtomicFlowRun | undefined;
  private readonly entries: HookOperationEvent[] = [];
  private readonly maxEntries: number;
  private readonly parentInstanceId?: string | undefined;
  private readonly sink?: HookEventHandler | undefined;
  private readonly spans = new Map<string, AtomicSpan>();
  private readonly trajectory?: TrajectoryRecorder | undefined;

  public constructor(options: HookAuditOptions = {}) {
    this.atomicFlow = options.atomicFlow;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.parentInstanceId = options.parentInstanceId;
    this.sink = options.sink;
    this.trajectory = options.trajectory;

    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error("Hook audit maxEntries must be a positive safe integer.");
    }
  }

  public recent(limit = this.maxEntries): readonly HookOperationEvent[] {
    const resolvedLimit = Math.max(0, Math.min(limit, this.maxEntries));
    return Object.freeze(resolvedLimit === 0 ? [] : this.entries.slice(-resolvedLimit));
  }

  public clear(): void {
    this.entries.length = 0;
  }

  private recordAtomic(event: HookOperationEvent): void {
    if (this.atomicFlow === undefined) {
      return;
    }

    if (event.phase === "start") {
      if (!this.spans.has(event.operationId)) {
        this.spans.set(event.operationId, this.startSpan(event));
      }
      return;
    }

    const span = this.spans.get(event.operationId) ?? this.startSpan(event);
    this.spans.delete(event.operationId);
    if (event.phase === "error") {
      span.fail(toAtomicPayload(event));
    } else {
      span.end(toAtomicPayload(event));
    }
  }

  private startSpan(event: HookOperationEvent): AtomicSpan {
    if (this.atomicFlow === undefined) {
      throw new Error("Hook audit Atomic Flow is unavailable.");
    }

    return this.atomicFlow.start({
      atom: hookAtom(event.operation, event.eventName ?? `Hook ${event.operation}`),
      instanceId: event.operationId,
      parentInstanceId: event.parentInvocationId ?? this.parentInstanceId,
      payload: toAtomicPayload(event),
    });
  }
}

function sanitizeEvent(event: HookOperationEvent): HookOperationEvent {
  return Object.freeze({
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.counts !== undefined ? { counts: Object.freeze({ ...event.counts }) } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
    ...(event.eventName !== undefined ? { eventName: event.eventName } : {}),
    ...(event.executorType !== undefined ? { executorType: event.executorType } : {}),
    ...(event.hookId !== undefined ? { hookId: event.hookId } : {}),
    ...(event.invocationId !== undefined ? { invocationId: event.invocationId } : {}),
    operation: event.operation,
    operationId: event.operationId,
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.parentInvocationId !== undefined
      ? { parentInvocationId: event.parentInvocationId }
      : {}),
    phase: event.phase,
    ...(event.sourceType !== undefined ? { sourceType: event.sourceType } : {}),
    startedAt: event.startedAt,
    ...(event.truncatedBytes !== undefined ? { truncatedBytes: event.truncatedBytes } : {}),
  });
}

function toAtomicPayload(event: HookOperationEvent): AtomicPayloadSummary {
  const values: Record<string, AtomicValue> = {
    operation: event.operation,
    phase: event.phase,
  };
  if (event.eventName !== undefined) {
    values.eventName = event.eventName;
  }
  if (event.executorType !== undefined) {
    values.executorType = event.executorType;
  }
  if (event.sourceType !== undefined) {
    values.sourceType = event.sourceType;
  }
  if (event.outcome !== undefined) {
    values.outcome = event.outcome;
  }

  return {
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.truncatedBytes !== undefined
      ? { counts: { truncatedBytes: event.truncatedBytes } }
      : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    values,
  };
}

function toOperationEvent(event: HookOperationEvent, parentInstanceId?: string): OperationEvent {
  return {
    ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
    ...(event.code !== undefined ? { error: event.code } : {}),
    kind: "hook",
    name: event.eventName ?? `hook.${event.operation}`,
    operationId: event.operationId,
    output: toAtomicPayload(event),
    ...((event.parentInvocationId ?? parentInstanceId)
      ? { parentId: event.parentInvocationId ?? parentInstanceId }
      : {}),
    phase: event.phase,
    startedAt: event.startedAt,
    status: event.phase === "start" ? "running" : event.phase === "error" ? "failed" : "completed",
  };
}
