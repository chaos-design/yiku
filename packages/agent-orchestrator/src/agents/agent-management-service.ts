import { randomUUID } from "node:crypto";
import type { UserQuestionHandler } from "@yiku/agent-code";
import type { AgentProgressHandler, AgentUsage } from "../runtime/types.js";
import type { AgentCreationRequest } from "../session/agent-creation-broker.js";
import type { SessionSubagentInstance, SessionSubagentProfile } from "../session/session-state.js";

export interface AgentOutputValidation {
  readonly diagnostics: readonly string[];
  readonly passed: boolean;
}

export interface SubagentRunResult {
  readonly agentId: string;
  readonly finalOutput: string;
  readonly profileId: string;
  readonly status: "succeeded";
  readonly taskId: string;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: AgentOutputValidation | undefined;
}

export interface AgentManagementCreateOptions {
  readonly createdBy: "agent" | "user";
  readonly questionHandler?: UserQuestionHandler | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AgentManagementRunOptions {
  readonly parentToolCallId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AgentManagementRunnerInput {
  readonly instance: SessionSubagentInstance;
  readonly parentToolCallId?: string | undefined;
  readonly profile: SessionSubagentProfile;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
}

export interface AgentManagementRunnerResult {
  readonly finalOutput: string;
  readonly usage?: AgentUsage | undefined;
  readonly validation?: AgentOutputValidation | undefined;
}

export interface AgentManagementBroker {
  create(
    request: AgentCreationRequest,
    options: AgentManagementCreateOptions,
  ): Promise<SessionSubagentProfile>;
}

export interface AgentManagementRegistry {
  finishInstance(
    agentId: string,
    status: "cancelled" | "failed" | "succeeded",
    error?: string,
  ): Promise<SessionSubagentInstance>;
  get(profileId: string): Promise<SessionSubagentProfile | undefined>;
  instances(profileId?: string): Promise<readonly SessionSubagentInstance[]>;
  list(): Promise<readonly SessionSubagentProfile[]>;
  remove(profileId: string): Promise<void>;
  startInstance(profileId: string, taskId: string): Promise<SessionSubagentInstance>;
}

export interface AgentManagementServiceOptions {
  readonly broker: AgentManagementBroker;
  readonly parentAgentId?: string | undefined;
  readonly parentSessionId?: string | undefined;
  readonly registry: AgentManagementRegistry;
  readonly run: (input: AgentManagementRunnerInput) => Promise<AgentManagementRunnerResult>;
  readonly taskIdGenerator?: (() => string) | undefined;
  readonly onEvent?: AgentProgressHandler | undefined;
}

export class AgentManagementService {
  private readonly taskIdGenerator: () => string;

  public constructor(private readonly options: AgentManagementServiceOptions) {
    this.taskIdGenerator = options.taskIdGenerator ?? randomUUID;
  }

  public async create(
    request: AgentCreationRequest,
    options: AgentManagementCreateOptions,
  ): Promise<SessionSubagentProfile> {
    const profile = await this.options.broker.create(request, options);
    this.options.onEvent?.({
      action: "created",
      agentType: profile.agentType,
      profileId: profile.id,
      type: "agent_profile_changed",
    });
    return profile;
  }

  public list(): Promise<readonly SessionSubagentProfile[]> {
    return this.options.registry.list();
  }

  public async remove(profileId: string): Promise<void> {
    const profile = await this.show(profileId);
    await this.options.registry.remove(profileId);
    this.options.onEvent?.({
      action: "removed",
      agentType: profile.agentType,
      profileId: profile.id,
      type: "agent_profile_changed",
    });
  }

  public async run(
    profileId: string,
    prompt: string,
    options: AgentManagementRunOptions = {},
  ): Promise<SubagentRunResult> {
    throwIfAborted(options.signal);
    const profile = await this.show(profileId);
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error("Subagent task prompt must be non-empty.");
    }
    const instance = await this.options.registry.startInstance(profile.id, this.taskIdGenerator());
    const agentSessionId = `${this.options.parentSessionId ?? "session"}.agent.${instance.agentId}`;
    this.options.onEvent?.({
      agentId: instance.agentId,
      agentName: profile.name,
      agentSessionId,
      agentType: profile.agentType,
      ...(this.options.parentAgentId !== undefined
        ? { parentAgentId: this.options.parentAgentId }
        : {}),
      ...(this.options.parentSessionId !== undefined
        ? { parentSessionId: this.options.parentSessionId }
        : {}),
      ...(options.parentToolCallId !== undefined
        ? { parentToolCallId: options.parentToolCallId }
        : {}),
      profileId: profile.id,
      prompt: normalizedPrompt,
      taskId: instance.taskId,
      type: "subagent_spawned",
    });

    try {
      const result = await this.options.run({
        instance,
        ...(options.parentToolCallId !== undefined
          ? { parentToolCallId: options.parentToolCallId }
          : {}),
        profile,
        prompt: normalizedPrompt,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      await this.options.registry.finishInstance(instance.agentId, "succeeded");
      this.options.onEvent?.({
        agentId: instance.agentId,
        agentName: profile.name,
        agentSessionId,
        output: result.finalOutput,
        profileId: profile.id,
        taskId: instance.taskId,
        type: "subagent_output",
      });
      this.options.onEvent?.({
        agentId: instance.agentId,
        agentName: profile.name,
        agentSessionId,
        profileId: profile.id,
        status: "succeeded",
        taskId: instance.taskId,
        type: "subagent_result",
      });
      return Object.freeze({
        agentId: instance.agentId,
        finalOutput: result.finalOutput,
        profileId: profile.id,
        status: "succeeded",
        taskId: instance.taskId,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.validation !== undefined ? { validation: result.validation } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.registry.finishInstance(
        instance.agentId,
        options.signal?.aborted ? "cancelled" : "failed",
        message,
      );
      this.options.onEvent?.({
        agentId: instance.agentId,
        agentName: profile.name,
        agentSessionId,
        error: message,
        profileId: profile.id,
        status: options.signal?.aborted ? "cancelled" : "failed",
        taskId: instance.taskId,
        type: "subagent_result",
      });
      throw error;
    }
  }

  public async show(profileId: string): Promise<SessionSubagentProfile> {
    const profile = await this.options.registry.get(profileId);
    if (profile === undefined) {
      throw new Error(`Subagent Profile not found: ${profileId}.`);
    }
    return profile;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("Subagent run was cancelled.");
}
