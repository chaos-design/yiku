import { randomUUID } from "node:crypto";
import { HookError, type HookEventBase, type HookSession } from "@yiku/hooks";
import type { AgentMessageBus } from "../messages/message-bus.js";
import type { AgentMessagePayload } from "../messages/types.js";

export interface SubagentMessageContext {
  readonly agentId: string;
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentSessionId?: string | undefined;
  readonly agentType: string;
  readonly parentAgentId?: string | undefined;
  readonly parentSessionId?: string | undefined;
  readonly parentToolCallId?: string | undefined;
  readonly profileId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly taskId: string;
}

export interface SubagentRunInput extends SubagentMessageContext {
  readonly agentTranscriptPath: string;
  readonly run: (feedback?: string) => Promise<string>;
}

export interface SubagentRuntimeOptions {
  readonly eventBase: HookEventBase<"SubagentStart">;
  readonly hookSession?: HookSession | undefined;
  readonly messageBus?: AgentMessageBus | undefined;
}

export class SubagentRuntime {
  public constructor(private readonly options: SubagentRuntimeOptions) {}

  public async run(input: SubagentRunInput): Promise<string> {
    const agentName = resolveAgentName(input);
    const profileId = resolveProfileId(input);
    await this.publish(input, {
      ...(input.agentKey !== undefined ? { agentKey: input.agentKey } : {}),
      agentName,
      agentType: input.agentType,
      kind: "agent_spawned",
      profileId,
      ...(input.prompt?.trim() ? { prompt: input.prompt } : {}),
    });

    const startDecision = await this.options.hookSession?.dispatch({
      ...this.options.eventBase,
      agent_id: input.agentId,
      agent_type: input.agentType,
      hook_event_name: "SubagentStart",
    });

    if (startDecision?.action === "block" || startDecision?.action === "stop") {
      throw new HookError(
        "HOOK_EXECUTION_FAILED",
        `Subagent start was blocked: ${startDecision.reasons.join("; ") || "blocked"}.`,
        { eventName: "SubagentStart" },
      );
    }

    let feedback: string | undefined;
    while (true) {
      const output = await input.run(feedback);
      const stopDecision = await this.options.hookSession?.dispatch({
        ...this.options.eventBase,
        agent_id: input.agentId,
        agent_transcript_path: input.agentTranscriptPath,
        agent_type: input.agentType,
        hook_event_name: "SubagentStop",
        last_assistant_message: output,
        stop_hook_active: feedback !== undefined,
      });

      if (stopDecision?.action !== "block") {
        await this.publish(input, {
          agentName,
          kind: "agent_output",
          profileId,
          text: output,
        });
        return output;
      }

      feedback = stopDecision.reasons.join("\n").trim() || "Continue the subagent task.";
    }
  }

  public async finish(
    context: SubagentMessageContext,
    status: "cancelled" | "failed" | "succeeded",
    error?: string,
  ): Promise<void> {
    await this.publish(context, {
      agentName: resolveAgentName(context),
      ...(error?.trim() ? { error: error.trim() } : {}),
      kind: "agent_finished",
      profileId: resolveProfileId(context),
      status,
    });
  }

  private async publish(
    context: SubagentMessageContext,
    payload: AgentMessagePayload,
  ): Promise<void> {
    await this.options.messageBus?.publish({
      agentId: context.agentId,
      agentSessionId:
        context.agentSessionId ?? `${this.options.eventBase.session_id}.agent.${context.agentId}`,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      ...(context.parentAgentId !== undefined ? { parentAgentId: context.parentAgentId } : {}),
      ...(context.parentToolCallId !== undefined
        ? { parentToolCallId: context.parentToolCallId }
        : {}),
      payload,
      sessionId: context.parentSessionId ?? this.options.eventBase.session_id,
      taskId: context.taskId,
    });
  }
}

function resolveAgentName(context: SubagentMessageContext): string {
  return (
    context.agentName?.trim() ||
    context.profileId?.trim() ||
    context.agentKey?.trim() ||
    context.agentType.trim() ||
    "subagent"
  );
}

function resolveProfileId(context: SubagentMessageContext): string {
  return context.profileId?.trim() || context.agentKey?.trim() || context.agentType.trim();
}
