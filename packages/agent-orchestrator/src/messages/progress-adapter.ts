import { randomUUID } from "node:crypto";
import type { AgentProgressEvent } from "../runtime/types.js";
import type { AgentMessageEnvelope, AgentMessagePayload } from "./types.js";

export interface AgentMessageCorrelation {
  readonly agentId: string;
  readonly agentSessionId?: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly sessionId: string;
  readonly taskId?: string;
}

interface EnvelopeMetadata {
  readonly eventId: string;
  readonly occurredAt: string;
}

type LifecyclePayload = Extract<AgentMessagePayload, { readonly kind: "session_lifecycle" }>;

const LEGACY_PROGRESS_EVENT_TYPES = {
  agent_profile_changed: true,
  agent_updated: true,
  checkpoint_saved: true,
  context_compacted: true,
  evaluation_finished: true,
  handoff: true,
  memory_operation: true,
  message_delta: true,
  prompt_risk_detected: true,
  reasoning: true,
  runtime_boundary_changed: true,
  session_cancelled: true,
  session_failed: true,
  session_finished: true,
  session_resumed: true,
  session_started: true,
  skill_activated: true,
  skill_resolved: true,
  skill_worker_finished: true,
  skill_worker_started: true,
  stage_finished: true,
  stage_started: true,
  subagent_output: true,
  subagent_result: true,
  subagent_spawned: true,
  task_snapshot: true,
  tool_called: true,
  tool_output: true,
  usage_updated: true,
  user_question_cancelled: true,
  user_question_requested: true,
  user_question_resolved: true,
} satisfies Readonly<Record<AgentProgressEvent["type"], true>>;

export function progressEventToEnvelope(
  event: AgentProgressEvent,
  correlation: AgentMessageCorrelation,
  options?: { readonly eventId?: string; readonly occurredAt?: string },
): AgentMessageEnvelope {
  const metadata = {
    eventId: options?.eventId ?? randomUUID(),
    occurredAt: options?.occurredAt ?? new Date().toISOString(),
  };

  switch (event.type) {
    case "message_delta":
      return createEnvelope({ kind: "assistant_delta", text: event.text }, correlation, metadata);
    case "reasoning":
      return createEnvelope({ kind: "reasoning" }, correlation, metadata);
    case "memory_operation": {
      const { type: _type, ...memoryEvent } = event;
      return createEnvelope(
        {
          ...memoryEvent,
          kind: "memory_operation",
        },
        correlation,
        metadata,
      );
    }
    case "tool_called":
      return createEnvelope(
        {
          ...(event.effect !== undefined ? { effect: event.effect } : {}),
          ...(event.input !== undefined ? { input: event.input } : {}),
          kind: "tool_called",
          summary: event.summary,
          title: event.title,
          toolName: event.toolName,
        },
        correlation,
        metadata,
        event.callId,
      );
    case "tool_output":
      return createEnvelope(
        {
          ...(event.effect !== undefined ? { effect: event.effect } : {}),
          kind: "tool_output",
          ...(event.output !== undefined ? { output: event.output } : {}),
          summary: event.summary,
          title: event.title,
          toolName: event.toolName,
        },
        correlation,
        metadata,
        event.callId,
      );
    case "usage_updated":
      return createEnvelope(
        {
          kind: "usage",
          model: event.model,
          usage: event.usage,
        },
        correlation,
        metadata,
      );
    case "runtime_boundary_changed":
      return createEnvelope(
        {
          from: event.from,
          kind: "runtime_boundary_changed",
          reason: event.reason,
          to: event.to,
        },
        correlation,
        metadata,
      );
    case "subagent_spawned":
      return createEnvelope(
        {
          ...definedProperties({
            agentKey: event.agentKey,
            agentName: event.agentName,
            prompt: event.prompt,
          }),
          agentType: event.agentType,
          kind: "agent_spawned",
          profileId: event.profileId,
        },
        childCorrelation(event, correlation),
        metadata,
      );
    case "subagent_output":
      return createEnvelope(
        {
          ...definedProperties({ agentName: event.agentName }),
          kind: "agent_output",
          profileId: event.profileId,
          text: event.output,
        },
        childCorrelation(event, correlation),
        metadata,
      );
    case "subagent_result":
      return createEnvelope(
        {
          ...definedProperties({
            agentName: event.agentName,
            error: event.error,
          }),
          kind: "agent_finished",
          profileId: event.profileId,
          status: event.status,
        },
        childCorrelation(event, correlation),
        metadata,
      );
    case "agent_profile_changed":
    case "agent_updated":
    case "checkpoint_saved":
    case "context_compacted":
    case "evaluation_finished":
    case "handoff":
    case "prompt_risk_detected":
    case "session_cancelled":
    case "session_failed":
    case "session_finished":
    case "session_resumed":
    case "session_started":
    case "skill_activated":
    case "skill_resolved":
    case "skill_worker_finished":
    case "skill_worker_started":
    case "stage_finished":
    case "stage_started":
    case "task_snapshot":
    case "user_question_cancelled":
    case "user_question_requested":
    case "user_question_resolved":
      return createEnvelope(lifecyclePayload(event), correlation, metadata);
  }
}

export function envelopeToProgressEvent(
  envelope: AgentMessageEnvelope,
): AgentProgressEvent | undefined {
  const payload = envelope.payload;

  switch (payload.kind) {
    case "assistant_delta":
      return {
        text: payload.text,
        type: "message_delta",
      };
    case "reasoning":
      return { type: "reasoning" };
    case "memory_operation": {
      const { kind: _kind, ...memoryEvent } = payload;
      return {
        ...memoryEvent,
        type: "memory_operation",
      };
    }
    case "tool_called":
      return {
        ...(envelope.toolCallId !== undefined ? { callId: envelope.toolCallId } : {}),
        ...(payload.effect !== undefined ? { effect: payload.effect } : {}),
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        summary: payload.summary,
        title: payload.title,
        toolName: payload.toolName,
        type: "tool_called",
      };
    case "tool_output":
      return {
        ...(envelope.toolCallId !== undefined ? { callId: envelope.toolCallId } : {}),
        ...(payload.effect !== undefined ? { effect: payload.effect } : {}),
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        summary: payload.summary,
        title: payload.title,
        toolName: payload.toolName,
        type: "tool_output",
      };
    case "agent_spawned":
      if (envelope.taskId === undefined) {
        return undefined;
      }
      return {
        agentId: envelope.agentId,
        ...definedProperties({
          agentKey: payload.agentKey,
          agentName: payload.agentName,
          agentSessionId: envelope.agentSessionId,
          parentAgentId: envelope.parentAgentId,
          parentToolCallId: envelope.parentToolCallId,
          prompt: payload.prompt,
        }),
        agentType: payload.agentType,
        parentSessionId: envelope.sessionId,
        profileId: payload.profileId,
        taskId: envelope.taskId,
        type: "subagent_spawned",
      };
    case "agent_output":
      if (envelope.taskId === undefined || payload.profileId === undefined) {
        return undefined;
      }
      return {
        agentId: envelope.agentId,
        ...definedProperties({
          agentName: payload.agentName,
          agentSessionId: envelope.agentSessionId,
        }),
        output: payload.text,
        profileId: payload.profileId,
        taskId: envelope.taskId,
        type: "subagent_output",
      };
    case "session_lifecycle":
      return lifecyclePayloadToProgressEvent(payload);
    case "usage":
      return {
        model: payload.model,
        type: "usage_updated",
        usage: payload.usage,
      };
    case "runtime_boundary_changed":
      return {
        from: payload.from,
        reason: payload.reason,
        to: payload.to,
        type: "runtime_boundary_changed",
      };
    case "agent_finished":
      if (envelope.taskId === undefined || payload.profileId === undefined) {
        return undefined;
      }
      return {
        agentId: envelope.agentId,
        ...definedProperties({
          agentName: payload.agentName,
          agentSessionId: envelope.agentSessionId,
          error: payload.error,
        }),
        profileId: payload.profileId,
        status: payload.status,
        taskId: envelope.taskId,
        type: "subagent_result",
      };
    case "checkpoint":
    case "hook_decision":
      return undefined;
  }
}

function createEnvelope(
  payload: AgentMessagePayload,
  correlation: AgentMessageCorrelation,
  metadata: EnvelopeMetadata,
  toolCallId?: string,
): AgentMessageEnvelope {
  return {
    agentId: correlation.agentId,
    ...definedProperties({
      agentSessionId: correlation.agentSessionId,
      parentAgentId: correlation.parentAgentId,
      parentToolCallId: correlation.parentToolCallId,
      taskId: correlation.taskId,
      toolCallId,
    }),
    eventId: metadata.eventId,
    occurredAt: metadata.occurredAt,
    payload,
    sessionId: correlation.sessionId,
  };
}

function childCorrelation(
  event: Extract<
    AgentProgressEvent,
    { type: "subagent_output" | "subagent_result" | "subagent_spawned" }
  >,
  correlation: AgentMessageCorrelation,
): AgentMessageCorrelation {
  const eventParentAgentId =
    "parentAgentId" in event && typeof event.parentAgentId === "string"
      ? event.parentAgentId
      : undefined;
  const eventParentToolCallId =
    "parentToolCallId" in event && typeof event.parentToolCallId === "string"
      ? event.parentToolCallId
      : undefined;
  const parentAgentId =
    eventParentAgentId ??
    (event.agentId === correlation.agentId ? correlation.parentAgentId : correlation.agentId);

  return {
    agentId: event.agentId,
    ...definedProperties({
      agentSessionId: event.agentSessionId,
      parentAgentId,
      parentToolCallId: eventParentToolCallId ?? correlation.parentToolCallId,
    }),
    sessionId: correlation.sessionId,
    taskId: event.taskId,
  };
}

function lifecyclePayload(event: AgentProgressEvent): LifecyclePayload {
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (key !== "type" && value !== undefined) {
      values[key] = value;
    }
  }

  return {
    kind: "session_lifecycle",
    phase: event.type,
    values,
  };
}

function lifecyclePayloadToProgressEvent(
  payload: LifecyclePayload,
): AgentProgressEvent | undefined {
  if (
    !isLegacyProgressEventType(payload.phase) ||
    typeof payload.values !== "object" ||
    payload.values === null ||
    Array.isArray(payload.values)
  ) {
    return undefined;
  }

  return {
    ...(payload.values as Record<string, unknown>),
    type: payload.phase,
  } as AgentProgressEvent;
}

function definedProperties<T extends Readonly<Record<string, unknown>>>(
  values: T,
): { readonly [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== undefined)) as {
    readonly [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function isLegacyProgressEventType(value: string): value is AgentProgressEvent["type"] {
  return Object.hasOwn(LEGACY_PROGRESS_EVENT_TYPES, value);
}
