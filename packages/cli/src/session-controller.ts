import type {
  AgentSessionEndReason,
  CheckpointRecord,
  McpRegistryStatusEntry,
  SessionState,
  SessionSubagentProfile,
  SubagentRunResult,
  UserQuestionHandler,
  UserQuestionResponse,
} from "@yiku/agent-orchestrator";
import type {
  CliAgentSession,
  CliAgentSessionContract,
  CliAgentSessionSubmitOptions,
  CliHookInteractionOptions,
  CliModelSummary,
  CliSkillCommand,
  CloneCurrentSessionOptions,
} from "./agent-session.js";
import type { MemoryController } from "./app/memory-controller.js";
import type { HookController } from "./hooks/controller.js";
import type { SessionExportResult } from "./services/session-export-service.js";

export interface CliSessionControllerOptions {
  readonly createSession: (
    resumeSessionId: string,
    options?: { readonly resumeStartsEpoch?: boolean | undefined },
  ) => CliAgentSession;
  readonly initialSession: CliAgentSession;
  readonly onInputEnabled?: ((enabled: boolean) => Promise<void> | void) | undefined;
  readonly onTimelineReplay?:
    | ((state: SessionState | undefined) => Promise<void> | void)
    | undefined;
}

export class CliSessionController implements CliAgentSessionContract {
  private current: CliAgentSession;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly createSession: CliSessionControllerOptions["createSession"];
  private readonly onInputEnabled?: ((enabled: boolean) => Promise<void> | void) | undefined;
  private readonly onTimelineReplay?:
    | ((state: SessionState | undefined) => Promise<void> | void)
    | undefined;

  public constructor(options: CliSessionControllerOptions) {
    this.current = options.initialSession;
    this.createSession = options.createSession;
    this.onInputEnabled = options.onInputEnabled;
    this.onTimelineReplay = options.onTimelineReplay;
  }

  public ready(): Promise<void> {
    return this.current.ready();
  }

  public stateSnapshot(): Promise<SessionState | undefined> {
    return this.current.stateSnapshot();
  }

  public currentModel(): Promise<string | undefined> {
    return this.current.currentModel();
  }

  public models(): Promise<readonly CliModelSummary[]> {
    return this.current.models();
  }

  public mcpStatus(): Promise<readonly McpRegistryStatusEntry[]> {
    return this.current.mcpStatus();
  }

  public reconnectMcp(server: string): Promise<void> {
    return this.current.reconnectMcp(server);
  }

  public outputStyle(): Promise<SessionState["outputStyle"]> {
    return this.current.outputStyle();
  }

  public async setOutputStyle(style: SessionState["outputStyle"]): Promise<SessionState> {
    return this.current.setOutputStyle(style);
  }

  public exportSession(filePath?: string): Promise<SessionExportResult> {
    return this.current.exportSession(filePath);
  }

  public submit(prompt: string, options?: CliAgentSessionSubmitOptions): Promise<string> {
    return this.enqueue(() => this.current.submit(prompt, options));
  }

  public clear(options?: CliHookInteractionOptions): Promise<void> {
    return this.current.clear(options);
  }

  public compact(instructions?: string, options?: CliHookInteractionOptions): Promise<void> {
    return this.current.compact(instructions, options);
  }

  public setup(
    trigger: "init" | "maintenance",
    options?: CliHookInteractionOptions,
  ): Promise<void> {
    return this.current.setup(trigger, options);
  }

  public close(reason?: AgentSessionEndReason): Promise<void> {
    return this.current.close(reason);
  }

  public answerUserQuestion(questionId: string, response: UserQuestionResponse): void {
    this.current.answerUserQuestion(questionId, response);
  }

  public cancelUserQuestion(questionId: string, reason?: string): void {
    this.current.cancelUserQuestion(questionId, reason);
  }

  public pendingUserQuestions(): ReturnType<CliAgentSession["pendingUserQuestions"]> {
    return this.current.pendingUserQuestions();
  }

  public hooks(): Promise<HookController | undefined> {
    return this.current.hooks();
  }

  public memories(): Promise<MemoryController | undefined> {
    return this.current.memories();
  }

  public skills(): Promise<readonly CliSkillCommand[]> {
    return this.current.skills();
  }

  public createAgent(
    intent: string | undefined,
    questionHandler: UserQuestionHandler,
  ): Promise<SessionSubagentProfile> {
    return this.current.createAgent(intent, questionHandler);
  }

  public createSkill(intent: string, reservedNames?: readonly string[]): Promise<CliSkillCommand> {
    return this.current.createSkill(intent, reservedNames);
  }

  public installSkill(
    source: string,
    selector?: string,
    reservedNames?: readonly string[],
  ): Promise<CliSkillCommand> {
    return this.current.installSkill(source, selector, reservedNames);
  }

  public listAgents(): Promise<readonly SessionSubagentProfile[]> {
    return this.current.listAgents();
  }

  public removeAgent(profileId: string): Promise<void> {
    return this.current.removeAgent(profileId);
  }

  public runAgent(
    profileId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SubagentRunResult> {
    return this.current.runAgent(profileId, prompt, signal);
  }

  public showAgent(profileId: string): Promise<SessionSubagentProfile> {
    return this.current.showAgent(profileId);
  }

  public listSessions(): Promise<readonly SessionState[]> {
    return this.current.listSessions();
  }

  public renameCurrent(title: string): Promise<SessionState> {
    return this.current.renameCurrent(title);
  }

  public renameSession(sessionId: string, title: string): Promise<SessionState> {
    return this.current.renameSession(sessionId, title);
  }

  public cloneCurrent(options?: CloneCurrentSessionOptions): Promise<SessionState> {
    return this.current.cloneCurrent(options);
  }

  public removeSession(id: string): Promise<void> {
    return this.current.removeSession(id);
  }

  public checkpoints(): Promise<readonly CheckpointRecord[]> {
    return this.current.checkpoints();
  }

  public rewind(id: string): Promise<void> {
    return this.current.rewind(id);
  }

  public startSessionEpoch(id: string): Promise<SessionState> {
    return this.current.startSessionEpoch(id);
  }

  public async branch(title?: string): Promise<void> {
    const cloned = await this.current.cloneCurrent(title === undefined ? undefined : { title });
    await this.switch(cloned.sessionId);
  }

  public switch(sessionId: string): Promise<void> {
    return this.enqueue(() => this.switchCurrent(sessionId));
  }

  public setModel(modelKey: string, options: { readonly global: boolean }): Promise<void> {
    return this.enqueue(() => this.replaceModel(modelKey, options));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async switchCurrent(sessionId: string): Promise<void> {
    const source = this.current;
    let target: CliAgentSession | undefined;
    let activated = false;

    try {
      await this.onInputEnabled?.(false);
      const sessions = await source.listSessions();
      const targetState = sessions.find((state) => state.sessionId === sessionId);
      if (targetState === undefined) {
        throw new Error(`Session does not exist in the current workspace: ${sessionId}.`);
      }
      if (targetState.status === "completed" || targetState.status === "failed") {
        await source.startSessionEpoch(sessionId);
      }

      target = this.createSession(sessionId, {
        resumeStartsEpoch: targetState.status !== "completed" && targetState.status !== "failed",
      });
      await target.ready();
      await source.close("resume");
      this.current = target;
      activated = true;
      await this.onTimelineReplay?.(await target.stateSnapshot());
    } catch (error) {
      if (target !== undefined && !activated) {
        await target.close("resume").catch(() => undefined);
      }
      throw error;
    } finally {
      await this.onInputEnabled?.(true);
    }
  }

  private async replaceModel(
    modelKey: string,
    options: { readonly global: boolean },
  ): Promise<void> {
    const source = this.current;
    const sourceState = await source.stateSnapshot();
    if (sourceState === undefined) {
      throw new Error("Model switching requires a durable Session.");
    }
    if (sourceState.modelKey === modelKey) {
      if (options.global) {
        await source.setGlobalModel(modelKey);
      }
      return;
    }

    let target: CliAgentSession | undefined;
    let stateUpdated = false;
    try {
      await this.onInputEnabled?.(false);
      await source.setCurrentModel(modelKey);
      stateUpdated = true;
      target = this.createSession(sourceState.sessionId);
      await target.ready();
      if (options.global) {
        await source.setGlobalModel(modelKey);
      }
      await source.close("resume");
      this.current = target;
      target = undefined;
      await this.onTimelineReplay?.(await this.current.stateSnapshot());
    } catch (error) {
      await target?.close("resume").catch(() => undefined);
      if (stateUpdated) {
        await source.setCurrentModel(sourceState.modelKey).catch(() => undefined);
      }
      throw error;
    } finally {
      await this.onInputEnabled?.(true);
    }
  }
}
