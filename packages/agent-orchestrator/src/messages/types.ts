import type { ToolEffect } from "@yiku/agent-code";
import type { MemoryOperationEvent } from "@yiku/memories";
import type { AgentUsage } from "../runtime/types.js";

export interface AgentExecutionIdentity {
  readonly agentId: string;
  readonly agentKey?: string | undefined;
  readonly agentName: string;
  readonly agentSessionId: string;
  readonly agentType: string;
  readonly parentAgentId: string;
  readonly parentSessionId: string;
  readonly parentToolCallId?: string | undefined;
  readonly profileId?: string | undefined;
  readonly prompt: string;
  readonly taskId: string;
}

export type AgentMessagePayload =
  | {
      readonly kind: "assistant_delta";
      readonly text: string;
    }
  | {
      readonly kind: "reasoning";
    }
  | (MemoryOperationEvent & {
      readonly kind: "memory_operation";
    })
  | {
      readonly effect?: ToolEffect;
      readonly input?: unknown;
      readonly kind: "tool_called";
      readonly summary: string;
      readonly title: string;
      readonly toolName: string;
    }
  | {
      readonly effect?: ToolEffect;
      readonly kind: "tool_output";
      readonly output?: unknown;
      readonly summary: string;
      readonly title: string;
      readonly toolName: string;
    }
  | {
      readonly agentKey?: string | undefined;
      readonly agentName?: string | undefined;
      readonly agentType: string;
      readonly kind: "agent_spawned";
      readonly profileId: string;
      readonly prompt?: string | undefined;
    }
  | {
      readonly agentName?: string | undefined;
      readonly kind: "agent_output";
      readonly profileId?: string | undefined;
      readonly text: string;
    }
  | {
      readonly agentName?: string | undefined;
      readonly error?: string | undefined;
      readonly kind: "agent_finished";
      readonly profileId?: string | undefined;
      readonly status: "cancelled" | "failed" | "succeeded";
    }
  | {
      readonly kind: "session_lifecycle";
      readonly phase: string;
      readonly values?: unknown;
    }
  | {
      readonly action: string;
      readonly eventName: string;
      readonly kind: "hook_decision";
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "usage";
      readonly model: string;
      readonly usage: AgentUsage;
    }
  | {
      readonly action: "created" | "restored";
      readonly checkpointId: string;
      readonly kind: "checkpoint";
    }
  | {
      readonly from: string;
      readonly kind: "runtime_boundary_changed";
      readonly reason: string;
      readonly to: string;
    };

export interface AgentMessageEnvelope<TPayload extends AgentMessagePayload = AgentMessagePayload> {
  readonly agentId: string;
  readonly agentSessionId?: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
  readonly payload: TPayload;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly toolCallId?: string;
}

export interface AgentMessageSink {
  publish(message: AgentMessageEnvelope): Promise<void> | void;
}

export type AgentMessageSinkRegistration = AgentMessageSink &
  (
    | {
        readonly kind: "optional";
      }
    | {
        readonly kind: "required";
      }
  );
