import type { AtomicDefinition, AtomicFlowRun, AtomicSpan, AtomicValue } from "@yiku/atomic-flow";
import { CAPABILITY_ATOMS, RUNTIME_ATOMS } from "./atoms.js";
import type { AgentProgressEvent } from "./types.js";

const ATOMIC_CAPTURE_MAX_CHARACTERS = 32_000;

interface CapabilityAtomicState {
  readonly agentSpans: Map<string, AtomicSpan>;
  readonly skillSpans: Map<string, AtomicSpan>;
  readonly subagentSpans: Map<string, AtomicSpan>;
}

const CAPABILITY_STATES = new WeakMap<AtomicFlowRun, CapabilityAtomicState>();

export class AtomicRuntime {
  private iteration = 0;
  private loopSpan: AtomicSpan | undefined;
  private modelCharacters = 0;
  private modelEndedForTurn = false;
  private modelHadReasoning = false;
  private modelSpan: AtomicSpan | undefined;
  private readonly toolSpans = new Map<string, AtomicSpan>();

  public constructor(
    private readonly flow: AtomicFlowRun,
    private readonly runInstanceId: string,
  ) {}

  public record(event: AgentProgressEvent): void {
    if (recordRuntimeAtomicEvent(this.flow, event, this.runInstanceId)) {
      return;
    }

    switch (event.type) {
      case "agent_updated":
        this.emitCompleted(
          RUNTIME_ATOMS.agentSelect,
          {
            summary: event.agentName,
          },
          { fromAtomKey: "loop.turn" },
        );
        return;
      case "handoff":
        this.emitCompleted(
          RUNTIME_ATOMS.handoff,
          {
            summary: `${event.sourceAgentName ?? "unknown"} -> ${event.targetAgentName}`,
          },
          { fromAtomKey: "action.gate" },
        );
        return;
      case "reasoning":
        if (this.canRecordModelEvent()) {
          this.ensureModel();
          this.modelHadReasoning = true;
        }
        return;
      case "message_delta":
        if (this.canRecordModelEvent()) {
          this.ensureModel();
          this.modelCharacters += event.text.length;
        }
        return;
      case "tool_called": {
        if (this.canRecordModelEvent()) {
          this.ensureModel();
          this.endModel("tool selected");
        }
        this.emitCompleted(
          RUNTIME_ATOMS.actionGate,
          {
            summary: "tool",
          },
          { fromAtomKey: "model.invoke" },
        );
        const toolSpan = this.flow.start({
          atom: RUNTIME_ATOMS.toolCall,
          edge: {
            fromAtomKey: "action.gate",
            kind: "execution",
            toAtomKey: "tool.call",
          },
          parentInstanceId: this.ensureTurn().instanceId,
          payload: {
            summary: event.toolName,
            title: event.title,
            values: {
              ...(event.callId !== undefined ? { callId: event.callId } : {}),
              ...(event.effect !== undefined ? { effect: event.effect } : {}),
              ...(event.input !== undefined ? { input: capturedAtomicValue(event.input) } : {}),
              toolName: event.toolName,
            },
          },
        });
        this.toolSpans.set(event.callId ?? event.toolName, toolSpan);
        return;
      }
      case "tool_output": {
        const correlationKey = event.callId ?? event.toolName;
        const span = this.toolSpans.get(correlationKey);
        span?.end({
          summary: event.summary,
          title: event.title,
          values: {
            ...(event.callId !== undefined ? { callId: event.callId } : {}),
            ...(event.effect !== undefined ? { effect: event.effect } : {}),
            output: capturedAtomicValue(event.output === undefined ? event.summary : event.output),
            toolName: event.toolName,
          },
        });
        this.toolSpans.delete(correlationKey);
        this.emitCompleted(
          RUNTIME_ATOMS.observation,
          {
            summary: event.toolName,
          },
          { fromAtomKey: "tool.call" },
        );
        if (this.toolSpans.size === 0) {
          this.endTurn("tool result");
        }
        return;
      }
      case "session_cancelled":
      case "session_failed":
      case "session_finished":
      case "session_started":
      case "memory_operation":
      case "user_question_cancelled":
      case "user_question_requested":
      case "user_question_resolved":
        return;
    }
  }

  public complete(output: unknown): void {
    if (this.canRecordModelEvent()) {
      this.ensureModel();
      this.endModel("model completed");
    }
    this.emitCompleted(
      RUNTIME_ATOMS.actionGate,
      {
        summary: "reply",
      },
      { fromAtomKey: "model.invoke" },
    );
    this.endTurn("final reply");
    this.emitCompleted(
      RUNTIME_ATOMS.replyFinal,
      {
        counts: {
          characters: typeof output === "string" ? output.length : 0,
        },
        ...(output !== undefined
          ? {
              values: {
                output: capturedAtomicValue(output),
              },
            }
          : {}),
      },
      {
        fromAtomKey: "action.gate",
        parentInstanceId: this.runInstanceId,
      },
    );
  }

  public stop(reason: string): void {
    this.endModel(reason);
    this.loopSpan?.end({ summary: reason });
    this.loopSpan = undefined;

    for (const span of this.toolSpans.values()) {
      span.fail({
        code: "AGENT_STAGE_STOPPED",
        summary: reason,
      });
    }
    this.toolSpans.clear();
  }

  public fail(error: unknown, code = "AGENT_RUN_FAILED"): void {
    const payload = {
      code,
      counts: {
        characters: this.modelCharacters,
      },
      summary: error instanceof Error ? error.message : String(error),
      values: {
        reasoning: this.modelHadReasoning,
      },
    };
    this.modelSpan?.fail(payload);
    this.modelSpan = undefined;
    this.modelEndedForTurn = true;
    this.loopSpan?.fail(payload);
    this.loopSpan = undefined;

    for (const span of this.toolSpans.values()) {
      span.fail(payload);
    }
    this.toolSpans.clear();
  }

  private ensureTurn(): AtomicSpan {
    if (this.loopSpan === undefined) {
      const firstTurn = this.iteration === 0;
      this.iteration += 1;
      this.modelCharacters = 0;
      this.modelEndedForTurn = false;
      this.modelHadReasoning = false;
      this.loopSpan = this.flow.start({
        atom: RUNTIME_ATOMS.loopTurn,
        edge: {
          fromAtomKey: firstTurn ? "run" : "observation",
          kind: firstTurn ? "execution" : "feedback",
          toAtomKey: "loop.turn",
        },
        iteration: this.iteration,
        parentInstanceId: this.runInstanceId,
        payload: {
          values: {
            iteration: this.iteration,
          },
        },
      });
    }
    return this.loopSpan;
  }

  private ensureModel(): AtomicSpan {
    if (this.modelSpan === undefined) {
      this.modelSpan = this.flow.start({
        atom: RUNTIME_ATOMS.modelInvoke,
        edge: {
          fromAtomKey: "agent.select",
          kind: "execution",
          toAtomKey: "model.invoke",
        },
        iteration: this.iteration + (this.loopSpan === undefined ? 1 : 0),
        parentInstanceId: this.ensureTurn().instanceId,
      });
    }
    return this.modelSpan;
  }

  private canRecordModelEvent(): boolean {
    if (this.loopSpan === undefined) {
      this.ensureTurn();
    }
    return !this.modelEndedForTurn;
  }

  private endTurn(summary: string): void {
    if (!this.modelEndedForTurn) {
      this.endModel(summary);
    }
    this.loopSpan?.end({ summary });
    this.loopSpan = undefined;
  }

  private endModel(summary: string): void {
    this.modelSpan?.end({
      counts: {
        characters: this.modelCharacters,
      },
      summary,
      values: {
        reasoning: this.modelHadReasoning,
      },
    });
    this.modelSpan = undefined;
    this.modelEndedForTurn = true;
  }

  private emitCompleted(
    atom: AtomicDefinition,
    payload: Parameters<AtomicSpan["end"]>[0],
    options: {
      readonly edgeKind?: "execution" | "feedback";
      readonly fromAtomKey?: string;
      readonly parentInstanceId?: string;
    } = {},
  ): void {
    const span = this.flow.start({
      atom,
      ...(options.fromAtomKey !== undefined
        ? {
            edge: {
              fromAtomKey: options.fromAtomKey,
              kind: options.edgeKind ?? "execution",
              toAtomKey: atom.key,
            },
          }
        : {}),
      parentInstanceId: options.parentInstanceId ?? this.ensureTurn().instanceId,
      ...(payload !== undefined ? { payload } : {}),
    });
    span.end(payload);
  }
}

function capturedAtomicValue(value: unknown): AtomicValue {
  const seen = new WeakSet<object>();
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") {
        return `${current}n`;
      }
      if (typeof current === "number" && !Number.isFinite(current)) {
        return `[${String(current)}]`;
      }
      if (typeof current === "function") {
        return `[Function ${current.name || "anonymous"}]`;
      }
      if (typeof current === "symbol") {
        return `[Symbol ${current.description ?? ""}]`;
      }
      if (current instanceof Error) {
        return {
          message: current.message,
          name: current.name,
          ...(current.stack !== undefined ? { stack: current.stack } : {}),
        };
      }
      if (current instanceof Map) {
        return Object.fromEntries(current);
      }
      if (current instanceof Set) {
        return [...current];
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }
      if (current === undefined) {
        return "[undefined]";
      }
      return current;
    });
  } catch (error) {
    return `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }

  if (serialized === undefined) {
    return `[${typeof value}]`;
  }
  if (serialized.length > ATOMIC_CAPTURE_MAX_CHARACTERS) {
    const suffix = `\n[truncated after ${ATOMIC_CAPTURE_MAX_CHARACTERS} characters]`;
    return `${serialized.slice(0, ATOMIC_CAPTURE_MAX_CHARACTERS - suffix.length)}${suffix}`;
  }
  try {
    return JSON.parse(serialized) as AtomicValue;
  } catch {
    return serialized;
  }
}

export function recordRuntimeAtomicEvent(
  flow: AtomicFlowRun,
  event: AgentProgressEvent,
  parentInstanceId?: string,
): boolean {
  if (recordCapabilityAtomicEvent(flow, event, parentInstanceId)) {
    return true;
  }
  const resolved = runtimeEventAtom(event);
  if (resolved === undefined) {
    return false;
  }

  const events = flow.snapshot().events;
  const sourceEvent =
    resolved.fromAtomKey === undefined
      ? undefined
      : events.findLast((candidate) => candidate.atom.key === resolved.fromAtomKey);
  const parent =
    parentInstanceId ??
    sourceEvent?.instance.id ??
    events.findLast(
      (candidate) =>
        candidate.atom.key === RUNTIME_ATOMS.run.key ||
        candidate.atom.key === RUNTIME_ATOMS.inputPrompt.key,
    )?.instance.id;
  const span = flow.start({
    atom: resolved.atom,
    ...(sourceEvent !== undefined
      ? {
          edge: {
            fromAtomKey: sourceEvent.atom.key,
            kind: resolved.edgeKind ?? ("execution" as const),
            toAtomKey: resolved.atom.key,
          },
        }
      : {}),
    ...(parent !== undefined ? { parentInstanceId: parent } : {}),
    payload: resolved.payload,
  });
  span.end(resolved.payload);
  return true;
}

export function findRuntimeToolInstanceId(
  flow: AtomicFlowRun,
  callId: string | undefined,
): string | undefined {
  if (callId === undefined) {
    return undefined;
  }
  return flow
    .snapshot()
    .events.findLast(
      (event) =>
        event.atom.key === RUNTIME_ATOMS.toolCall.key &&
        event.phase === "start" &&
        event.payload?.values?.callId === callId,
    )?.instance.id;
}

export function getSubagentExecutionInstanceId(
  flow: AtomicFlowRun,
  agentId: string,
): string | undefined {
  return capabilityState(flow).agentSpans.get(agentId)?.instanceId;
}

function recordCapabilityAtomicEvent(
  flow: AtomicFlowRun,
  event: AgentProgressEvent,
  parentInstanceId?: string,
): boolean {
  const state = capabilityState(flow);
  switch (event.type) {
    case "skill_resolved":
      emitCapabilityCompleted(flow, CAPABILITY_ATOMS.skillResolve, parentInstanceId, undefined, {
        summary: `${event.name}@${event.digest.slice(0, 8)}`,
        values: {
          digest: event.digest,
          name: event.name,
          source: event.source,
        },
      });
      return true;
    case "skill_activated":
      emitCapabilityCompleted(
        flow,
        CAPABILITY_ATOMS.skillActivate,
        parentInstanceId,
        CAPABILITY_ATOMS.skillResolve.key,
        {
          summary: event.name,
          values: {
            name: event.name,
            targetId: event.targetId,
          },
        },
      );
      return true;
    case "skill_worker_started": {
      const span = startCapabilitySpan(
        flow,
        CAPABILITY_ATOMS.skillExecute,
        parentInstanceId,
        CAPABILITY_ATOMS.skillActivate.key,
        {
          summary: event.name,
          values: {
            name: event.name,
            workerId: event.workerId,
          },
        },
      );
      state.skillSpans.set(event.workerId, span);
      return true;
    }
    case "skill_worker_finished": {
      const span =
        state.skillSpans.get(event.workerId) ??
        startCapabilitySpan(
          flow,
          CAPABILITY_ATOMS.skillExecute,
          parentInstanceId,
          CAPABILITY_ATOMS.skillActivate.key,
          {
            summary: event.name,
            values: { workerId: event.workerId },
          },
        );
      if (event.status === "failed") {
        span.fail({ code: "SKILL_WORKER_FAILED", summary: event.name });
      } else {
        span.end({ summary: event.name });
      }
      state.skillSpans.delete(event.workerId);
      return true;
    }
    case "agent_profile_changed":
      emitCapabilityCompleted(
        flow,
        CAPABILITY_ATOMS.agentProfile,
        parentInstanceId,
        RUNTIME_ATOMS.taskSnapshot.key,
        {
          summary: `${event.profileId}: ${event.action}`,
          values: {
            action: event.action,
            agentType: event.agentType,
            profileId: event.profileId,
          },
        },
      );
      return true;
    case "subagent_spawned": {
      const identity = subagentAtomicIdentity(event);
      const lifecycleSpan = startCapabilitySpan(
        flow,
        RUNTIME_ATOMS.subagentLifecycle,
        parentInstanceId,
        RUNTIME_ATOMS.taskSnapshot.key,
        {
          summary: identity.agentName,
          values: {
            ...identity,
            agentKey: event.agentKey ?? event.profileId,
            parentAgentId: event.parentAgentId ?? "",
            parentSessionId: event.parentSessionId ?? "",
            parentToolCallId: event.parentToolCallId ?? "",
            prompt: event.prompt ?? "",
          },
        },
      );
      state.subagentSpans.set(event.agentId, lifecycleSpan);
      const spawnSource = flow
        .snapshot()
        .events.some((candidate) => candidate.atom.key === CAPABILITY_ATOMS.agentProfile.key)
        ? CAPABILITY_ATOMS.agentProfile.key
        : RUNTIME_ATOMS.subagentLifecycle.key;
      emitCapabilityCompleted(flow, CAPABILITY_ATOMS.agentSpawn, parentInstanceId, spawnSource, {
        summary: identity.agentName,
        values: identity,
      });
      const span = startCapabilitySpan(
        flow,
        CAPABILITY_ATOMS.agentExecute,
        parentInstanceId,
        CAPABILITY_ATOMS.agentSpawn.key,
        {
          summary: identity.agentName,
          values: identity,
        },
      );
      state.agentSpans.set(event.agentId, span);
      return true;
    }
    case "subagent_output": {
      const identity = subagentAtomicIdentity(event);
      state.agentSpans.get(event.agentId)?.delta({
        summary: identity.agentName,
        values: {
          ...identity,
          output: capturedAtomicValue(event.output),
        },
      });
      return true;
    }
    case "subagent_result": {
      const identity = subagentAtomicIdentity(event);
      const span =
        state.agentSpans.get(event.agentId) ??
        startCapabilitySpan(
          flow,
          CAPABILITY_ATOMS.agentExecute,
          parentInstanceId,
          CAPABILITY_ATOMS.agentSpawn.key,
          {
            summary: identity.agentName,
            values: identity,
          },
        );
      if (event.status === "succeeded") {
        span.end({ summary: event.status });
      } else {
        span.fail({
          code: event.status === "cancelled" ? "SUBAGENT_CANCELLED" : "SUBAGENT_FAILED",
          summary: event.status,
        });
      }
      state.agentSpans.delete(event.agentId);
      const lifecycleSpan =
        state.subagentSpans.get(event.agentId) ??
        startCapabilitySpan(
          flow,
          RUNTIME_ATOMS.subagentLifecycle,
          parentInstanceId,
          RUNTIME_ATOMS.taskSnapshot.key,
          {
            summary: identity.agentName,
            values: identity,
          },
        );
      if (event.status === "succeeded") {
        lifecycleSpan.end({ summary: event.status });
      } else {
        lifecycleSpan.fail({
          code: event.status === "cancelled" ? "SUBAGENT_CANCELLED" : "SUBAGENT_FAILED",
          summary: event.status,
        });
      }
      state.subagentSpans.delete(event.agentId);
      emitCapabilityCompleted(
        flow,
        CAPABILITY_ATOMS.agentResult,
        parentInstanceId,
        CAPABILITY_ATOMS.agentExecute.key,
        {
          summary: event.status,
          values: {
            ...identity,
            status: event.status,
          },
        },
      );
      return true;
    }
    default:
      return false;
  }
}

function subagentAtomicIdentity(
  event: Extract<
    AgentProgressEvent,
    { readonly type: "subagent_output" | "subagent_result" | "subagent_spawned" }
  >,
) {
  return {
    agentId: event.agentId,
    agentName: event.agentName ?? event.profileId,
    agentSessionId: event.agentSessionId ?? "",
    agentType: event.type === "subagent_spawned" ? event.agentType : "",
    profileId: event.profileId,
    taskId: event.taskId,
  };
}

function capabilityState(flow: AtomicFlowRun): CapabilityAtomicState {
  const existing = CAPABILITY_STATES.get(flow);
  if (existing !== undefined) {
    return existing;
  }
  const state: CapabilityAtomicState = {
    agentSpans: new Map(),
    skillSpans: new Map(),
    subagentSpans: new Map(),
  };
  CAPABILITY_STATES.set(flow, state);
  return state;
}

function startCapabilitySpan(
  flow: AtomicFlowRun,
  atom: AtomicDefinition,
  parentInstanceId: string | undefined,
  fromAtomKey: string | undefined,
  payload: Parameters<AtomicSpan["end"]>[0],
): AtomicSpan {
  const source =
    fromAtomKey === undefined
      ? undefined
      : flow.snapshot().events.findLast((event) => event.atom.key === fromAtomKey);
  return flow.start({
    atom,
    ...(source !== undefined
      ? {
          edge: {
            fromAtomKey: source.atom.key,
            kind: "execution" as const,
            toAtomKey: atom.key,
          },
        }
      : {}),
    ...((parentInstanceId ?? source?.instance.id)
      ? { parentInstanceId: parentInstanceId ?? source?.instance.id }
      : {}),
    ...(payload !== undefined ? { payload } : {}),
  });
}

function emitCapabilityCompleted(
  flow: AtomicFlowRun,
  atom: AtomicDefinition,
  parentInstanceId: string | undefined,
  fromAtomKey: string | undefined,
  payload: Parameters<AtomicSpan["end"]>[0],
): void {
  startCapabilitySpan(flow, atom, parentInstanceId, fromAtomKey, payload).end(payload);
}

function runtimeEventAtom(event: AgentProgressEvent):
  | {
      readonly atom: AtomicDefinition;
      readonly edgeKind?: "data" | "execution" | "feedback" | "persistence";
      readonly fromAtomKey?: string;
      readonly payload: Parameters<AtomicSpan["end"]>[0];
    }
  | undefined {
  switch (event.type) {
    case "usage_updated":
      return {
        atom: RUNTIME_ATOMS.usageRecord,
        edgeKind: "data",
        fromAtomKey: RUNTIME_ATOMS.modelInvoke.key,
        payload: {
          counts: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            totalTokens: event.usage.totalTokens,
          },
        },
      };
    case "checkpoint_saved":
      return {
        atom: RUNTIME_ATOMS.sessionCheckpoint,
        edgeKind: "persistence",
        fromAtomKey: RUNTIME_ATOMS.stageStart.key,
        payload: {
          summary: event.sessionStatus,
          values: {
            revision: event.checkpointRevision,
            stageId: event.stageId,
          },
        },
      };
    case "context_compacted":
      return {
        atom: RUNTIME_ATOMS.contextCompact,
        fromAtomKey: RUNTIME_ATOMS.stageFinish.key,
        payload: {
          counts: {
            afterEntries: event.afterEntries,
            beforeEntries: event.beforeEntries,
          },
        },
      };
    case "session_resumed":
      return {
        atom: RUNTIME_ATOMS.sessionResume,
        payload: {
          counts: {
            inFlightOperations: event.inFlightOperations,
          },
          summary: event.sessionId,
          ...(event.continuation === undefined && event.pendingInputIds === undefined
            ? {}
            : {
                values: {
                  ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
                  ...(event.pendingInputIds === undefined
                    ? {}
                    : { pendingInputIds: event.pendingInputIds }),
                },
              }),
        },
      };
    case "stage_started":
      return {
        atom: RUNTIME_ATOMS.stageStart,
        fromAtomKey: RUNTIME_ATOMS.sessionResume.key,
        payload: {
          summary: event.stageId,
          values: {
            stage: event.stage,
            totalStages: event.totalStages,
          },
        },
      };
    case "stage_finished":
      return {
        atom: RUNTIME_ATOMS.stageFinish,
        fromAtomKey: RUNTIME_ATOMS.run.key,
        payload: {
          ...(event.reason !== undefined ? { code: event.reason } : {}),
          summary: `${event.stageId}: ${event.outcome}`,
        },
      };
    case "task_snapshot":
      return {
        atom: RUNTIME_ATOMS.taskSnapshot,
        fromAtomKey: RUNTIME_ATOMS.stageStart.key,
        payload: {
          counts: {
            blocked: event.blocked,
            completed: event.completed,
            inProgress: event.inProgress,
            pending: event.pending,
          },
        },
      };
    case "runtime_boundary_changed":
      return {
        atom: RUNTIME_ATOMS.runtimeBoundary,
        fromAtomKey: RUNTIME_ATOMS.toolCall.key,
        payload: {
          code: "RUNTIME_BOUNDARY_CHANGED",
          summary: `${event.from} -> ${event.to}`,
          values: {
            from: event.from,
            reason: event.reason,
            to: event.to,
          },
        },
      };
    case "user_question_cancelled":
    case "user_question_requested":
    case "user_question_resolved":
      return {
        atom: RUNTIME_ATOMS.userQuestion,
        fromAtomKey: RUNTIME_ATOMS.toolCall.key,
        payload: {
          ...(event.type === "user_question_cancelled" ? { code: "cancelled" } : {}),
          summary: event.type.replace("user_question_", ""),
          values: {
            questionId: event.questionId,
            ...(event.type === "user_question_resolved" && event.selectedIndex !== undefined
              ? { selectedIndex: event.selectedIndex }
              : {}),
          },
        },
      };
    default:
      return undefined;
  }
}
