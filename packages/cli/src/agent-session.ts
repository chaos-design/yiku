import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentCreationBroker,
  AgentFactoryRegistry,
  AgentManagementService,
  type AgentProfileGenerator,
  type AgentProgressEvent,
  type AgentProgressHandler,
  type AgentSessionClassOptions,
  type AgentSessionContext,
  type AgentSessionEndReason,
  type AgentSessionMemoryOptions,
  type AgentSessionOptions,
  type CheckpointRecord,
  CodeAgentFactory,
  type ContextWindowSource,
  createSessionAtomicFlow,
  DefaultSkillRegistry,
  discoverAgentWorkspaceScopes,
  type EvaluationOutcome,
  evalProfileForAgent,
  HookAudit,
  type McpConnectionFactory,
  McpElicitationBridge,
  type McpElicitationHandler,
  McpRegistry,
  type McpRegistryStatusEntry,
  McpServerFactory,
  MemoryRuntime,
  mcpServerTrustDescriptor,
  OpenAIAgentProfileGenerator,
  OpenAIContextSummarizer,
  OpenAIHookAgentRunner,
  OpenAIHookModelRunner,
  OpenAIMemoryExtractor,
  OpenAISkillGenerator,
  type PendingUserQuestion,
  type PermissionApprovalHandler,
  type PermissionAssessment,
  type PermissionAssessmentHandler,
  type PermissionRequest,
  type PermissionResponse,
  ResearchAgentFactory,
  type RuntimeStoragePaths,
  recordRuntimeAtomicEvent,
  resolveAgentGraph,
  resolveModelConfig,
  runAgentSession,
  runAgentSessionTurn,
  SessionAgentRegistry,
  SessionRuntime,
  type SessionRuntimeOptions,
  type SessionRuntimeSubmitOptions,
  type SessionState,
  type SessionStore,
  type SessionSubagentProfile,
  SessionWorkingMemoryStore,
  SkillCreationService,
  type SkillDescriptor,
  type SkillGenerator,
  SkillInstallationService,
  type SkillSource,
  type SkillSourceCloner,
  type SubagentRunResult,
  UserAgentProfileStore,
  type UserQuestionHandler,
  type UserQuestionResponse,
  UserSkillStore,
  WorkspaceAccessController,
  WorkspaceSnapshotStore,
} from "@yiku/agent-orchestrator";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import { ConfigStore } from "@yiku/config";
import {
  AgentHookExecutor,
  CallbackHookExecutor,
  CommandHookExecutor,
  HookConfigCompiler,
  type HookConfigDocument,
  HookConfigLoader,
  HookEngine,
  HookExecutorRegistry,
  type HookOperationEvent,
  HookSession,
  type HookTrustApprovalHandler,
  HookTrustError,
  HookTrustPolicy,
  type HookTrustRequest,
  HookTrustStore,
  HttpHookExecutor,
  hookSource,
  PromptHookExecutor,
} from "@yiku/hooks";
import { MemoryController } from "./app/memory-controller.js";
import { HookController, type HookStatusMessageHandler } from "./hooks/controller.js";
import { migrateLegacyConfig, migrateLegacyRuntime } from "./migration/index.js";
import { PermissionProfileStore } from "./permission/profile-store.js";
import { PermissionRuleMatcher } from "./permission/rule-matcher.js";
import {
  type SessionExportResult,
  SessionExportService,
} from "./services/session-export-service.js";
import {
  CliSessionBootstrap,
  type CliSessionBootstrapResult,
  CliSessionState,
} from "./session-bootstrap.js";

type RunAgentSession = typeof runAgentSession;

export type { AgentProgressHandler, AgentSessionContext };

export interface ExecuteAgentSessionOptions extends AgentSessionOptions {
  readonly runAgentSessionImpl?: RunAgentSession | undefined;
}

export interface CliAgentSessionOptions extends AgentSessionClassOptions {
  readonly agentProfileGenerator?: AgentProfileGenerator | undefined;
  readonly continueSession?: boolean | undefined;
  readonly discoverHooks?: boolean | undefined;
  readonly mcpServerFactory?: McpConnectionFactory | undefined;
  readonly migrateLegacy?: boolean | undefined;
  readonly permissionPolicyMode?: "external" | "profile" | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly resumeStartsEpoch?: boolean | undefined;
  readonly runAgentSessionImpl?: RunAgentSession | undefined;
  readonly skillGenerator?: SkillGenerator | undefined;
  readonly skillSourceCloner?: SkillSourceCloner | undefined;
  readonly trustStorePath?: string | undefined;
}

export interface CliAgentSessionSubmitOptions extends SessionRuntimeSubmitOptions {
  readonly hookTrustApprovalHandler?: HookTrustApprovalHandler | undefined;
  readonly mcpElicitationHandler?: McpElicitationHandler | undefined;
  readonly onHookStatusMessage?: HookStatusMessageHandler | undefined;
}

export interface CliSkillCommand {
  readonly description?: string | undefined;
  readonly digest?: string | undefined;
  readonly name: string;
  readonly path?: string | undefined;
  readonly source?: SkillSource | undefined;
  readonly version?: string | undefined;
}

export type CliHookInteractionOptions = Pick<
  CliAgentSessionSubmitOptions,
  "hookTrustApprovalHandler" | "onHookStatusMessage"
>;

export interface CloneCurrentSessionOptions {
  readonly sessionId?: string | undefined;
  readonly title?: string | undefined;
}

export interface CliModelSummary {
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly key: string;
  readonly model: string;
  readonly provider?: string | undefined;
}

export interface CliAgentSessionContract {
  answerUserQuestion(questionId: string, response: UserQuestionResponse): void;
  branch?(title?: string): Promise<void>;
  cancelUserQuestion(questionId: string, reason?: string): void;
  checkpoints?(): Promise<readonly CheckpointRecord[]>;
  clear(options?: CliHookInteractionOptions): Promise<void>;
  close(reason?: AgentSessionEndReason): Promise<void>;
  cloneCurrent?(options?: CloneCurrentSessionOptions): Promise<SessionState>;
  compact?(instructions?: string, options?: CliHookInteractionOptions): Promise<void>;
  createAgent?(
    intent: string | undefined,
    questionHandler: UserQuestionHandler,
  ): Promise<SessionSubagentProfile>;
  createSkill?(intent: string, reservedNames?: readonly string[]): Promise<CliSkillCommand>;
  hooks(): Promise<HookController | undefined>;
  installSkill?(
    source: string,
    selector?: string,
    reservedNames?: readonly string[],
  ): Promise<CliSkillCommand>;
  currentModel?(): Promise<string | undefined>;
  evaluationOutcome?(): EvaluationOutcome | undefined;
  exportSession?(filePath?: string): Promise<SessionExportResult>;
  listAgents?(): Promise<readonly SessionSubagentProfile[]>;
  listSessions?(): Promise<readonly SessionState[]>;
  mcpStatus?(): Promise<readonly McpRegistryStatusEntry[]>;
  memories?(): Promise<MemoryController | undefined>;
  models?(): Promise<readonly CliModelSummary[]>;
  outputStyle?(): Promise<SessionState["outputStyle"]>;
  pendingUserQuestions(): readonly PendingUserQuestion[];
  ready?(): Promise<void>;
  removeAgent?(profileId: string): Promise<void>;
  removeSession?(id: string): Promise<void>;
  reconnectMcp?(server: string): Promise<void>;
  renameCurrent?(title: string): Promise<SessionState>;
  renameSession?(sessionId: string, title: string): Promise<SessionState>;
  runAgent?(profileId: string, prompt: string, signal?: AbortSignal): Promise<SubagentRunResult>;
  setup(trigger: "init" | "maintenance", options?: CliHookInteractionOptions): Promise<void>;
  showAgent?(profileId: string): Promise<SessionSubagentProfile>;
  skills?(): Promise<readonly CliSkillCommand[]>;
  startSessionEpoch?(id: string): Promise<SessionState>;
  stateSnapshot?(): Promise<SessionState | undefined>;
  submit(prompt: string, options?: CliAgentSessionSubmitOptions): Promise<string>;
  setCurrentModel?(modelKey: string): Promise<SessionState>;
  setGlobalModel?(modelKey: string): Promise<void>;
  setModel?(modelKey: string, options: { readonly global: boolean }): Promise<void>;
  setOutputStyle?(style: SessionState["outputStyle"]): Promise<SessionState>;
  switch?(sessionId: string): Promise<void>;
  rewind?(id: string): Promise<void>;
}

export async function executeAgentSession(
  prompt: string,
  options: ExecuteAgentSessionOptions = {},
): Promise<string> {
  const { runAgentSessionImpl = runAgentSession, ...sessionOptions } = options;
  return runAgentSessionImpl(prompt, sessionOptions);
}

export class CliAgentSession implements CliAgentSessionContract {
  private activeControlFlow?: AtomicFlowRun | undefined;
  private activeMcpElicitationHandler?: McpElicitationHandler | undefined;
  private activeTrustApprovalHandler?: HookTrustApprovalHandler | undefined;
  private agentManagementService?: AgentManagementService | undefined;
  private controller?: HookController | undefined;
  private createControlFlow?: (() => AtomicFlowRun) | undefined;
  private initialization?: Promise<void> | undefined;
  private mcpConnection?: Promise<void> | undefined;
  private mcpConnect?: (() => Promise<void>) | undefined;
  private mcpRegistry?: McpRegistry | undefined;
  private memoryController?: MemoryController | undefined;
  private latestEvaluationOutcome?: EvaluationOutcome | undefined;
  private modelSummaries: readonly CliModelSummary[] = [];
  private readonly pendingPermissionApprovals = new Map<string, Promise<PermissionResponse>>();
  private permissionProfileStore?: PermissionProfileStore | undefined;
  private permissionRuleMatcher?: PermissionRuleMatcher | undefined;
  private runtimePaths?: CliSessionBootstrapResult["paths"] | undefined;
  private session?: SessionRuntime | undefined;
  private sessionId?: string | undefined;
  private sessionStore?: SessionStore | undefined;
  private skillCreationService?: SkillCreationService | undefined;
  private skillInstallationService?: SkillInstallationService | undefined;
  private skillCommands: readonly CliSkillCommand[] = [];
  private readonly sessionPermissionGrants = new Set<string>();
  private workspaceDir?: string | undefined;
  private readonly workspaceAccessController: WorkspaceAccessController;

  public constructor(private readonly options: CliAgentSessionOptions = {}) {
    this.workspaceAccessController =
      options.workspaceAccessController ??
      new WorkspaceAccessController({
        accessMode: options.accessMode ?? "read-write",
      });
  }

  public ready(): Promise<void> {
    return this.initialize();
  }

  public evaluationOutcome(): EvaluationOutcome | undefined {
    return this.latestEvaluationOutcome;
  }

  public async stateSnapshot(): Promise<SessionState | undefined> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return undefined;
    }
    await this.ready();
    if (this.sessionId !== undefined && this.sessionStore !== undefined) {
      return this.sessionStore.load(this.sessionId);
    }
    return this.session?.stateSnapshot();
  }

  public async currentModel(): Promise<string | undefined> {
    return (await this.stateSnapshot())?.modelKey;
  }

  public async models(): Promise<readonly CliModelSummary[]> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return [];
    }
    await this.ready();
    return this.modelSummaries;
  }

  public async setCurrentModel(modelKey: string): Promise<SessionState> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Model switching is unavailable for an injected Agent Session.");
    }
    const { sessionId, store } = await this.requireDurableSession();
    const normalizedModelKey = this.normalizeConfiguredModelKey(modelKey);
    const current = await store.load(sessionId);
    return store.update(sessionId, current.revision, (state) => ({
      ...state,
      modelKey: normalizedModelKey,
    }));
  }

  public async setGlobalModel(modelKey: string): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Global model updates are unavailable for an injected Agent Session.");
    }
    await this.ready();
    const normalizedModelKey = this.normalizeConfiguredModelKey(modelKey);
    const paths = this.runtimePaths;
    if (paths === undefined) {
      throw new Error("CLI Agent Session configuration paths are unavailable.");
    }
    await new ConfigStore({ filePath: paths.configFilePath }).set(
      ["models", "default"],
      normalizedModelKey,
    );
  }

  public async outputStyle(): Promise<SessionState["outputStyle"]> {
    return (await this.stateSnapshot())?.outputStyle ?? "default";
  }

  public async setOutputStyle(style: SessionState["outputStyle"]): Promise<SessionState> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Output style changes are unavailable for an injected Agent Session.");
    }
    const { sessionId, store } = await this.requireDurableSession();
    const current = await store.load(sessionId);
    return store.update(sessionId, current.revision, (state) => ({
      ...state,
      outputStyle: style,
    }));
  }

  public async mcpStatus(): Promise<readonly McpRegistryStatusEntry[]> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return [];
    }
    await this.ready();
    return this.mcpRegistry?.status() ?? [];
  }

  public async reconnectMcp(server: string): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("MCP management is unavailable for an injected Agent Session.");
    }
    await this.ready();
    const registry = this.mcpRegistry;
    if (registry === undefined) {
      throw new Error("No MCP servers are configured for this Session.");
    }
    await registry.reconnect(server);
  }

  public async exportSession(filePath?: string): Promise<SessionExportResult> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Session export is unavailable for an injected Agent Session.");
    }
    await this.ready();
    const state = await this.stateSnapshot();
    const paths = this.runtimePaths;
    if (state === undefined || paths === undefined) {
      throw new Error("CLI Agent Session export state is unavailable.");
    }
    return new SessionExportService({
      eventLogPath: join(paths.sessionsDir, state.eventLogPath),
      exportsDir: join(paths.workspaceStorageDir, "exports"),
      model: state.modelKey,
      ...(state.title === undefined ? {} : { title: state.title }),
      workspaceDir: state.workspaceDir,
    }).export({
      ...(filePath === undefined ? {} : { filePath }),
      sessionId: state.sessionId,
    });
  }

  public async listSessions(): Promise<readonly SessionState[]> {
    const { store, workspaceDir } = await this.requireDurableSession();
    return store.list(workspaceDir);
  }

  public async renameCurrent(title: string): Promise<SessionState> {
    const { sessionId, store } = await this.requireDurableSession();
    return store.rename(sessionId, title);
  }

  public async renameSession(sessionId: string, title: string): Promise<SessionState> {
    return (await this.requireDurableSession()).store.rename(sessionId, title);
  }

  public async cloneCurrent(options: CloneCurrentSessionOptions = {}): Promise<SessionState> {
    const { sessionId, store } = await this.requireDurableSession();
    return store.clone(sessionId, {
      sessionId: options.sessionId ?? randomUUID(),
      ...(options.title !== undefined ? { title: options.title } : {}),
    });
  }

  public async removeSession(id: string): Promise<void> {
    return (await this.requireDurableSession()).store.remove(id);
  }

  public async startSessionEpoch(id: string): Promise<SessionState> {
    return (await this.requireDurableSession()).store.startEpoch(id);
  }

  public async submit(
    prompt: string,
    submitOptions: CliAgentSessionSubmitOptions = {},
  ): Promise<string> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return executeAgentSession(prompt, {
        ...this.baseSessionOptions(),
        ...submitOptions,
        runAgentSessionImpl: this.options.runAgentSessionImpl,
      });
    }

    this.activeMcpElicitationHandler = submitOptions.mcpElicitationHandler;
    this.activeTrustApprovalHandler = submitOptions.hookTrustApprovalHandler;

    try {
      await this.initialize();
      await this.ensureMcpConnected();
      if (this.session === undefined) {
        throw new Error("CLI Agent Session initialization did not create a session.");
      }
      this.controller?.setStatusMessageHandler(submitOptions.onHookStatusMessage);
      return await this.submitPersistent(prompt, submitOptions);
    } finally {
      this.activeMcpElicitationHandler = undefined;
      this.activeTrustApprovalHandler = undefined;
      this.controller?.setStatusMessageHandler(undefined);
    }
  }

  public async clear(options: CliHookInteractionOptions = {}): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return;
    }
    await this.withRuntimeInteraction(options, (session) => session.clear());
  }

  public async compact(
    instructions?: string,
    options: CliHookInteractionOptions = {},
  ): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Context compaction is unavailable for an injected Agent Session.");
    }
    await this.withRuntimeInteraction(options, (session) =>
      session.compact("manual", undefined, instructions),
    );
  }

  public answerUserQuestion(questionId: string, response: UserQuestionResponse): void {
    const session = this.session;
    if (session === undefined) {
      throw new Error("CLI Agent Session does not have an active Runtime.");
    }
    session.answerUserQuestion(questionId, response);
  }

  public cancelUserQuestion(questionId: string, reason?: string): void {
    const session = this.session;
    if (session === undefined) {
      throw new Error("CLI Agent Session does not have an active Runtime.");
    }
    session.cancelUserQuestion(questionId, reason);
  }

  public async createAgent(
    intent: string | undefined,
    questionHandler: UserQuestionHandler,
  ): Promise<SessionSubagentProfile> {
    const service = await this.requireAgentManagement();
    const flow = this.createControlFlow?.();
    this.activeControlFlow = flow;
    try {
      return await service.create(intent?.trim() ? { intent: intent.trim() } : {}, {
        createdBy: "user",
        questionHandler,
      });
    } finally {
      if (this.activeControlFlow === flow) {
        this.activeControlFlow = undefined;
      }
      await flow?.close();
    }
  }

  public async createSkill(
    intent: string,
    reservedNames: readonly string[] = [],
  ): Promise<CliSkillCommand> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Skill creation is unavailable for an injected Agent Session.");
    }
    await this.initialize();
    if (this.skillCreationService === undefined) {
      throw new Error("CLI Agent Session initialization did not create a Skill service.");
    }
    const descriptor = await this.skillCreationService.create(intent, { reservedNames });
    const command = toCliSkillCommand(descriptor);
    this.updateSkillCommand(command);
    return command;
  }

  public async installSkill(
    source: string,
    selector?: string,
    reservedNames: readonly string[] = [],
  ): Promise<CliSkillCommand> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Skill installation is unavailable for an injected Agent Session.");
    }
    await this.initialize();
    if (this.skillInstallationService === undefined) {
      throw new Error("CLI Agent Session initialization did not create a Skill installer.");
    }
    const descriptor = await this.skillInstallationService.install(source, {
      reservedNames,
      ...(selector?.trim() ? { selector: selector.trim() } : {}),
    });
    const command = toCliSkillCommand(descriptor);
    this.updateSkillCommand(command);
    return command;
  }

  public async listAgents(): Promise<readonly SessionSubagentProfile[]> {
    return (await this.requireAgentManagement()).list();
  }

  public pendingUserQuestions(): readonly PendingUserQuestion[] {
    return this.session?.pendingUserQuestions() ?? [];
  }

  public async checkpoints(): Promise<readonly CheckpointRecord[]> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return [];
    }
    return (await this.requireRuntimeSession()).checkpoints();
  }

  public async rewind(id: string): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Checkpoint rewind is unavailable for an injected Agent Session.");
    }
    await (await this.requireRuntimeSession()).rewind(id);
  }

  public async removeAgent(profileId: string): Promise<void> {
    await (await this.requireAgentManagement()).remove(profileId);
  }

  public async runAgent(
    profileId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SubagentRunResult> {
    return (await this.requireAgentManagement()).run(profileId, prompt, {
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  public async showAgent(profileId: string): Promise<SessionSubagentProfile> {
    return (await this.requireAgentManagement()).show(profileId);
  }

  public async hooks(): Promise<HookController | undefined> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return undefined;
    }
    await this.initialize();
    return this.controller;
  }

  public async memories(): Promise<MemoryController | undefined> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return undefined;
    }
    await this.initialize();
    return this.memoryController;
  }

  public async skills(): Promise<readonly CliSkillCommand[]> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return [];
    }
    await this.initialize();
    return this.skillCommands;
  }

  public async setup(
    trigger: "init" | "maintenance",
    setupOptions: CliHookInteractionOptions = {},
  ): Promise<void> {
    if (this.options.runAgentSessionImpl !== undefined) {
      return;
    }
    await this.withRuntimeInteraction(setupOptions, (session) =>
      session.setup(trigger, async () => undefined),
    );
  }

  public async close(reason: AgentSessionEndReason = "prompt_input_exit"): Promise<void> {
    if (this.initialization === undefined) {
      return;
    }
    try {
      await this.initialization;
      await this.activeControlFlow?.close();
      this.activeControlFlow = undefined;
      this.createControlFlow = undefined;
      try {
        await this.session?.close(reason);
      } catch (error) {
        if (isCloseTrustRequiredError(error)) {
          return;
        }
        throw error;
      }
    } finally {
      this.mcpConnection = undefined;
      this.mcpConnect = undefined;
      this.mcpRegistry = undefined;
      this.modelSummaries = [];
      this.pendingPermissionApprovals.clear();
      this.runtimePaths = undefined;
      this.session = undefined;
      this.sessionId = undefined;
      this.sessionStore = undefined;
      this.skillCreationService = undefined;
      this.skillInstallationService = undefined;
      this.sessionPermissionGrants.clear();
      this.workspaceDir = undefined;
    }
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.initializePersistent();
    return this.initialization;
  }

  private async requireDurableSession(): Promise<{
    readonly sessionId: string;
    readonly store: SessionStore;
    readonly workspaceDir: string;
  }> {
    await this.initialize();
    if (
      this.sessionId === undefined ||
      this.sessionStore === undefined ||
      this.workspaceDir === undefined
    ) {
      throw new Error("CLI Agent Session durable state is unavailable.");
    }
    return {
      sessionId: this.sessionId,
      store: this.sessionStore,
      workspaceDir: this.workspaceDir,
    };
  }

  private async requireRuntimeSession(): Promise<SessionRuntime> {
    await this.initialize();
    if (this.session === undefined) {
      throw new Error("CLI Agent Session initialization did not create a session.");
    }
    return this.session;
  }

  private normalizeConfiguredModelKey(modelKey: string): string {
    const normalizedModelKey = modelKey.trim();
    if (!this.modelSummaries.some((model) => model.key === normalizedModelKey)) {
      throw new Error(`Model is not configured: ${normalizedModelKey || "(empty)"}.`);
    }
    return normalizedModelKey;
  }

  private updateSkillCommand(command: CliSkillCommand): void {
    this.skillCommands = Object.freeze(
      [...this.skillCommands.filter((skill) => skill.name !== command.name), command].toSorted(
        (left, right) => left.name.localeCompare(right.name),
      ),
    );
  }

  private async withRuntimeInteraction<T>(
    options: CliHookInteractionOptions,
    operation: (session: SessionRuntime) => Promise<T>,
  ): Promise<T> {
    this.activeTrustApprovalHandler = options.hookTrustApprovalHandler;
    try {
      const session = await this.requireRuntimeSession();
      this.controller?.setStatusMessageHandler(options.onHookStatusMessage);
      return await operation(session);
    } finally {
      this.activeTrustApprovalHandler = undefined;
      this.controller?.setStatusMessageHandler(undefined);
    }
  }

  private async ensureMcpConnected(): Promise<void> {
    const connect = this.mcpConnect;
    if (connect === undefined) {
      return;
    }

    this.mcpConnection ??= connect();
    try {
      await this.mcpConnection;
    } catch (error) {
      this.mcpConnection = undefined;
      throw error;
    }
  }

  private async initializePersistent(): Promise<void> {
    const sessionOptions = this.baseSessionOptions();
    const migrationOptions = {
      homeDir: resolve(sessionOptions.homeDir ?? homedir()),
      workspaceDir: resolve(sessionOptions.cwd ?? process.cwd()),
    };
    if (this.options.migrateLegacy === true) {
      await migrateLegacyConfig(migrationOptions);
    }
    const bootstrap = await new CliSessionBootstrap({
      ...(sessionOptions.cwd !== undefined ? { cwd: sessionOptions.cwd } : {}),
      ...(sessionOptions.env !== undefined ? { env: sessionOptions.env } : {}),
      ...(sessionOptions.homeDir !== undefined ? { homeDir: sessionOptions.homeDir } : {}),
      ...(sessionOptions.modelsConfig !== undefined
        ? { modelsConfig: sessionOptions.modelsConfig }
        : {}),
    }).load();
    this.runtimePaths = bootstrap.paths;
    if (this.options.migrateLegacy === true) {
      await migrateLegacyRuntime(migrationOptions);
    }
    this.permissionProfileStore = new PermissionProfileStore({ homeDir: bootstrap.homeDir });
    this.permissionRuleMatcher = new PermissionRuleMatcher(
      await this.permissionProfileStore.load(),
    );
    this.skillCommands = Object.freeze(
      bootstrap.skillRegistry.list().map((skill) => {
        const descriptor = bootstrap.skillRuntime.inspect(skill.name);
        return Object.freeze({
          ...(skill.description !== undefined ? { description: skill.description } : {}),
          ...(descriptor !== undefined ? { digest: descriptor.digest } : {}),
          name: skill.name,
          ...(skill.path !== undefined ? { path: skill.path } : {}),
          ...(descriptor !== undefined ? { source: descriptor.source } : {}),
          ...(descriptor !== undefined ? { version: descriptor.version } : {}),
        });
      }),
    );
    const contextSummarizer =
      sessionOptions.contextSummarizer ??
      resolveContextSummarizer(
        bootstrap.environment,
        bootstrap.runtimeConfig.modelsConfig,
        sessionOptions.agentKey,
        sessionOptions.modelKey,
      );
    const resolvedSessionOptions: AgentSessionClassOptions = {
      ...sessionOptions,
      ...(contextSummarizer !== undefined ? { contextSummarizer } : {}),
      cwd: bootstrap.cwd,
      env: bootstrap.environment,
      homeDir: bootstrap.homeDir,
      modelsConfig: bootstrap.runtimeConfig.modelsConfig,
      promptSegments: Object.freeze([
        ...bootstrap.promptSegments,
        ...(sessionOptions.promptSegments ?? []),
      ]),
      skillRegistry: sessionOptions.skillRegistry ?? bootstrap.skillRegistry,
      skillRuntime: sessionOptions.skillRuntime ?? bootstrap.skillRuntime,
    };
    const trustStore = new HookTrustStore({
      filePath: resolve(
        this.options.trustStorePath ?? join(bootstrap.homeDir, ".yiku", "trust", "hooks.json"),
      ),
    });
    const trustPolicy = new HookTrustPolicy({
      approvalHandler: async (request: HookTrustRequest) =>
        this.activeTrustApprovalHandler?.(request) ?? {
          decision: "deny",
          reason: "Non-interactive external capabilities require pre-authorization.",
        },
      store: trustStore,
    });

    if (this.options.discoverHooks === false) {
      await this.createRuntime(bootstrap, resolvedSessionOptions, trustPolicy);
      return;
    }

    const loadedDocuments = await new HookConfigLoader({
      components: bootstrap.hookComponents,
    }).load();
    const documents = [...hookConfigDocuments(bootstrap), ...loadedDocuments];
    const snapshot = new HookConfigCompiler().compile(documents).snapshot;
    const executors = new HookExecutorRegistry([
      new CallbackHookExecutor(),
      new CommandHookExecutor(),
      new HttpHookExecutor(),
      ...resolveModelExecutors(
        bootstrap.environment,
        bootstrap.runtimeConfig.modelsConfig,
        sessionOptions.modelKey,
      ),
    ]);
    let controller: HookController | undefined;
    let hookAudit: HookAudit | undefined;
    const engine = new HookEngine({
      executors,
      onEvent: (event: HookOperationEvent) => {
        controller?.record(event);
        hookAudit?.handle(event);
      },
      snapshot,
      trustPolicy,
    });
    controller = new HookController({ engine, trustStore });
    this.controller = controller;
    await this.createRuntime(
      bootstrap,
      {
        ...resolvedSessionOptions,
        ...(snapshot.hooks.length > 0 ? { hooks: { engine } } : {}),
      },
      trustPolicy,
      (flow) => {
        hookAudit = flow === undefined ? undefined : new HookAudit({ atomicFlow: flow });
      },
    );
  }

  private async createRuntime(
    bootstrap: CliSessionBootstrapResult,
    sessionOptions: AgentSessionClassOptions,
    trustPolicy: HookTrustPolicy,
    onAtomicFlowChange?: SessionRuntimeOptions["onAtomicFlowChange"],
  ): Promise<void> {
    const storage = resolveRuntimeStorage(bootstrap);
    const durable = await new CliSessionState(bootstrap, {
      ...(sessionOptions.agentKey !== undefined ? { agentKey: sessionOptions.agentKey } : {}),
      ...(this.options.continueSession !== undefined
        ? { continueSession: this.options.continueSession }
        : {}),
      ...(sessionOptions.modelKey !== undefined ? { modelKey: sessionOptions.modelKey } : {}),
      ...(this.options.resumeSessionId !== undefined
        ? { resumeSessionId: this.options.resumeSessionId }
        : {}),
      ...(this.options.resumeStartsEpoch !== undefined
        ? { resumeStartsEpoch: this.options.resumeStartsEpoch }
        : {}),
      ...(sessionOptions.sessionId !== undefined ? { sessionId: sessionOptions.sessionId } : {}),
      sessionsDir: storage.sessionsDir,
    }).open();
    this.modelSummaries = configuredModels(bootstrap, durable.state.modelKey);
    const checkpointSnapshotStore = new WorkspaceSnapshotStore({
      storageDir: join(bootstrap.paths.workspaceStorageDir, "checkpoints"),
      workspaceDir: bootstrap.cwd,
    });
    this.skillCreationService = new SkillCreationService({
      generator:
        this.options.skillGenerator ??
        lazySkillGenerator(
          bootstrap.environment,
          bootstrap.runtimeConfig.modelsConfig,
          durable.state.modelKey,
        ),
      registry: bootstrap.skillRegistry,
      runtime: bootstrap.skillRuntime,
      store: new UserSkillStore({
        homeDir: bootstrap.homeDir,
        writable: (sessionOptions.accessMode ?? "read-write") === "read-write",
      }),
    });
    this.skillInstallationService = new SkillInstallationService({
      ...(this.options.skillSourceCloner !== undefined
        ? { cloneRepository: this.options.skillSourceCloner }
        : {}),
      homeDir: bootstrap.homeDir,
      registry: bootstrap.skillRegistry,
      runtime: bootstrap.skillRuntime,
      workspaceDir: bootstrap.cwd,
      writable: (sessionOptions.accessMode ?? "read-write") === "read-write",
    });
    this.createControlFlow = () =>
      createSessionAtomicFlow({
        atomicRunsDir: storage.atomicRunsDir,
        endpoint: bootstrap.environment.YIKU_ATOMIC_STUDIO_URL,
        kind: "control",
        prompt: "/agent-new",
        sessionId: durable.state.sessionId,
        trace: bootstrap.runtimeConfig.flow.trace,
        workspaceDir: bootstrap.cwd,
      });

    const runtimeSessionOptions = withSharedHookSession(
      {
        ...sessionOptions,
        additionalFileSystemRoots: Object.freeze([bootstrap.paths.yikuDir]),
        homeDir: bootstrap.homeDir,
        runtimeStorage: storage,
        sessionsDir: storage.sessionsDir,
      },
      bootstrap.environment,
    );
    const agentFactoryRegistry = sessionOptions.agentFactoryRegistry ?? new AgentFactoryRegistry();
    if (sessionOptions.agentFactoryRegistry === undefined) {
      agentFactoryRegistry.register(new CodeAgentFactory());
      agentFactoryRegistry.register(new ResearchAgentFactory());
    }
    const mcpSkillTargets = Object.fromEntries(
      [
        ...Object.values(bootstrap.runtimeConfig.skills).map(
          (skill) => [skill.name, skill.mcp] as const,
        ),
        ...bootstrap.skillRuntime.list().map((skill) => [skill.name, skill.mcpTargets] as const),
      ].filter(([, targets]) => targets.length > 0),
    );
    const mcpTargets = Object.values(mcpSkillTargets).flat();
    const mcpRegistry =
      mcpTargets.length === 0 ? undefined : new McpRegistry({ allowedTargets: mcpTargets });
    const profileStore = new UserAgentProfileStore({
      homeDir: bootstrap.homeDir,
      skillRuntime: bootstrap.skillRuntime,
      writable: (sessionOptions.accessMode ?? "read-write") === "read-write",
    });
    const agentRegistry = new SessionAgentRegistry({
      profileStore,
      sessionId: durable.state.sessionId,
      store: durable.store,
    });
    await agentRegistry.syncPersistedProfiles();
    const synchronizedSessionState = await durable.store.load(durable.state.sessionId);
    const agentBroker = new AgentCreationBroker({
      agentTypes: [
        ...new Set([
          ...configuredAgentTypes(bootstrap),
          ...agentFactoryRegistry.list().map((factory) => factory.type),
        ]),
      ],
      currentModelKey: durable.state.modelKey,
      generator:
        this.options.agentProfileGenerator ??
        lazyAgentProfileGenerator(
          bootstrap.environment,
          bootstrap.runtimeConfig.modelsConfig,
          durable.state.modelKey,
        ),
      modelKeys: configuredModelKeys(bootstrap),
      parentAccessMode: sessionOptions.accessMode ?? "read-write",
      registry: agentRegistry,
      scopes: await discoverAgentWorkspaceScopes(bootstrap.cwd),
      skillRuntime: bootstrap.skillRuntime,
    });
    const agentManagementService = new AgentManagementService({
      broker: agentBroker,
      onEvent: (event) => {
        if (this.activeControlFlow !== undefined) {
          recordRuntimeAtomicEvent(this.activeControlFlow, event);
          return;
        }
        this.session?.recordExternalEvent(event);
      },
      parentAgentId: durable.state.agentKey,
      parentSessionId: durable.state.sessionId,
      registry: agentRegistry,
      run: async ({ instance, parentToolCallId, profile, prompt, signal }) => {
        const skillNames = new Set(profile.skillSnapshots.map((skill) => skill.name));
        const skillRegistry = new DefaultSkillRegistry();
        for (const skill of bootstrap.skillRegistry.list()) {
          if (!skillNames.has(skill.name)) {
            skillRegistry.register(skill);
          }
        }
        for (const skill of profile.skillSnapshots) {
          skillRegistry.register({
            description: skill.description,
            digest: skill.digest,
            instructions: skill.instructions,
            name: skill.name,
            path: skill.path,
            source: skill.source,
          });
        }
        const profileMcpTargets = Object.fromEntries(
          profile.skillSnapshots
            .filter((skill) => skill.mcpTargets.length > 0)
            .map((skill) => [skill.name, skill.mcpTargets]),
        );
        const agentSessionId = `${durable.state.sessionId}.agent.${instance.agentId}`;
        const childSessionOptions = this.session?.childAgentSessionOptions({
          agentId: instance.agentId,
          agentSessionId,
          parentAgentId: durable.state.agentKey,
          ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
          sessionId: durable.state.sessionId,
          taskId: instance.taskId,
        });
        if (childSessionOptions === undefined) {
          throw new Error("CLI Agent Session Runtime is unavailable for subagent execution.");
        }
        const finalOutput = await runAgentSessionTurn(prompt, {
          ...runtimeSessionOptions,
          ...childSessionOptions,
          accessMode: profile.accessMode,
          activatedSkills: [...skillNames],
          ...(profile.source !== "user"
            ? {
                promptSegments: [
                  ...(runtimeSessionOptions.promptSegments ?? []),
                  {
                    content: profile.instructions,
                    digest: createHash("sha256").update(profile.instructions).digest("hex"),
                    kind: "instruction",
                    source: "workspace",
                    sourceId: profile.configPath ?? profile.id,
                    trust: "untrusted",
                  },
                ],
              }
            : { additionalInstructions: profile.instructions }),
          agentFactoryRegistry,
          agentKey: durable.state.agentKey,
          agentName: profile.name,
          agentManagementService: undefined,
          agentType: profile.agentType,
          evals: {
            enabled: false,
          },
          ...(mcpRegistry !== undefined
            ? {
                mcpRegistry,
                mcpSkillTargets: profileMcpTargets,
              }
            : {}),
          modelKey: profile.modelKey,
          onContext: undefined,
          onEvent: undefined,
          sessionId: agentSessionId,
          sessionsDir: durable.sessionsDir,
          ...(signal !== undefined ? { signal } : {}),
          skillRegistry,
        });
        return { finalOutput };
      },
    });
    this.agentManagementService = agentManagementService;
    const memoryRuntime =
      sessionOptions.memories === undefined
        ? new MemoryRuntime({
            agentId: durable.state.agentKey,
            enabled: bootstrap.runtimeConfig.memory.enabled,
            extraction: bootstrap.runtimeConfig.memory.extraction,
            extractor: resolveMemoryExtractor(
              bootstrap.environment,
              bootstrap.runtimeConfig.modelsConfig,
              durable.state.agentKey,
              durable.state.modelKey,
            ),
            failureMode: bootstrap.runtimeConfig.memory.failureMode,
            filePath: storage.memoryFilePath,
            sessionId: durable.state.sessionId,
            workspaceDir: bootstrap.cwd,
            workingStore: new SessionWorkingMemoryStore({
              sessionId: durable.state.sessionId,
              store: durable.store,
            }),
          })
        : undefined;
    const memoryOptions = sessionOptions.memories ?? memoryRuntime?.sessionOptions();
    this.memoryController = createMemoryController(
      memoryOptions,
      durable.state.sessionId,
      bootstrap,
    );
    const resources = [
      durable.store,
      ...(mcpRegistry !== undefined ? [mcpRegistry] : []),
      ...(memoryRuntime !== undefined ? [memoryRuntime] : []),
    ];
    try {
      if (mcpRegistry !== undefined) {
        const elicitation = new McpElicitationBridge({
          eventBase: {
            cwd: bootstrap.cwd,
            hook_event_name: "Elicitation",
            permission_mode: runtimeSessionOptions.hooks?.permissionMode ?? "default",
            session_id: durable.state.sessionId,
            transcript_path: join(
              durable.sessionsDir,
              `${durable.state.sessionId}.transcript.jsonl`,
            ),
          },
          ...(runtimeSessionOptions.hooks?.hookSession !== undefined
            ? { hookSession: runtimeSessionOptions.hooks.hookSession }
            : {}),
          userHandler: (request) =>
            this.activeMcpElicitationHandler?.(request) ?? { action: "decline" },
        });
        const factory =
          this.options.mcpServerFactory ??
          new McpServerFactory({
            elicitationHandler: (request) => elicitation.request(request),
            environment: bootstrap.environment,
          });
        const serverNames = new Set(
          mcpTargets
            .map((target) => target.split("/", 1)[0])
            .filter((name): name is string => name !== undefined && name.length > 0),
        );
        const serverConfigs = [...serverNames].map((name) => {
          const config = bootstrap.runtimeConfig.mcpServers[name];
          if (config === undefined) {
            throw new Error(`MCP server is not configured: ${name}.`);
          }
          mcpRegistry.register(factory.create(config));
          return config;
        });
        this.mcpConnect = async () => {
          for (const config of serverConfigs) {
            await trustPolicy.authorize(
              mcpServerTrustDescriptor(config, bootstrap.cwd, join(bootstrap.cwd, "config.yaml")),
            );
          }
          await mcpRegistry.connectAll();
        };
      }

      const rootAgentDefinition = resolveAgentGraph(bootstrap.runtimeConfig.modelsConfig).items.get(
        durable.state.agentKey,
      );
      const rootAgentType = runtimeSessionOptions.agentType ?? rootAgentDefinition?.type ?? "code";
      const resolvedEvalProfile = evalProfileForAgent(bootstrap.runtimeConfig.evals, rootAgentType);
      const defaultEvalOptions: AgentSessionOptions["evals"] = bootstrap.runtimeConfig.evals.enabled
        ? {
            enabled: true,
            maxConcurrentRuns: bootstrap.runtimeConfig.evals.maxConcurrentRuns,
            profile: resolvedEvalProfile.profile,
            providerConfig:
              resolvedEvalProfile.type === "research"
                ? {
                    freshnessDays: resolvedEvalProfile.freshnessDays,
                    minimumIndependentDomains: resolvedEvalProfile.minimumIndependentDomains,
                  }
                : {},
            repair: true,
          }
        : {
            enabled: false,
          };
      const selectedEvalOptions = runtimeSessionOptions.evals ?? defaultEvalOptions;
      const evalOptions: AgentSessionOptions["evals"] =
        selectedEvalOptions.enabled === false
          ? selectedEvalOptions
          : {
              ...selectedEvalOptions,
              onOutcome: (outcome) => {
                this.latestEvaluationOutcome = outcome;
                selectedEvalOptions.onOutcome?.(outcome);
              },
            };
      this.session = new SessionRuntime({
        ...runtimeSessionOptions,
        agentFactoryRegistry,
        agentManagementService,
        agentKey: durable.state.agentKey,
        agentName:
          runtimeSessionOptions.agentName ?? rootAgentDefinition?.name ?? durable.state.agentKey,
        agentType: rootAgentType,
        budgetConfig: bootstrap.runtimeConfig.budget,
        checkpointSnapshotStore,
        flowConfig: bootstrap.runtimeConfig.flow,
        evals: evalOptions,
        indexFilePath: join(durable.sessionsDir, `${durable.state.sessionId}.checkpoints.json`),
        ...(memoryOptions !== undefined ? { memories: memoryOptions } : {}),
        ...(mcpRegistry !== undefined
          ? {
              mcpRegistry,
              mcpSkillTargets,
            }
          : {}),
        modelKey: durable.state.modelKey,
        ...(onAtomicFlowChange !== undefined ? { onAtomicFlowChange } : {}),
        resources,
        resumed: durable.resumed,
        sessionId: durable.state.sessionId,
        sessionsDir: durable.sessionsDir,
        sessionState: synchronizedSessionState,
        store: durable.store,
      });
      this.mcpRegistry = mcpRegistry;
      this.sessionId = durable.state.sessionId;
      this.sessionStore = durable.store;
      this.workspaceDir = bootstrap.cwd;
    } catch (error) {
      this.mcpConnect = undefined;
      this.mcpRegistry = undefined;
      this.sessionId = undefined;
      this.sessionStore = undefined;
      this.workspaceDir = undefined;
      await Promise.allSettled(resources.map((resource) => resource.close()));
      throw error;
    }
  }

  private async submitPersistent(
    prompt: string,
    submitOptions: CliAgentSessionSubmitOptions,
  ): Promise<string> {
    this.latestEvaluationOutcome = undefined;
    const session = this.session;
    if (session === undefined) {
      throw new Error("CLI Agent Session is unavailable.");
    }

    const presentedSegments: Array<{ original: string; presented: string }> = [];
    let pendingMessage = "";
    let eventQueue = Promise.resolve();
    const flushMessage = async () => {
      if (!pendingMessage) {
        return;
      }

      const original = pendingMessage;
      pendingMessage = "";
      const presented = await session.present(original);
      presentedSegments.push({
        original,
        presented: presented.message ?? "",
      });
      if (presented.message) {
        submitOptions.onEvent?.({
          text: presented.message,
          type: "message_delta",
        });
      }
    };
    const onEvent = (event: AgentProgressEvent) => {
      if (event.type === "message_delta") {
        pendingMessage += event.text;
        return;
      }

      eventQueue = eventQueue.then(async () => {
        await flushMessage();
        submitOptions.onEvent?.(event);
      });
    };
    const {
      hookTrustApprovalHandler: _hookTrustApprovalHandler,
      mcpElicitationHandler: _mcpElicitationHandler,
      onHookStatusMessage: _onHookStatusMessage,
      permissionApprovalHandler,
      permissionAssessmentHandler,
      ...runtimeSubmitOptions
    } = submitOptions;
    const output = await session.submit(prompt, {
      ...runtimeSubmitOptions,
      onEvent,
      permissionApprovalHandler: this.permissionHandler(permissionApprovalHandler),
      permissionAssessmentHandler: this.permissionAssessmentHandler(permissionAssessmentHandler),
    });
    await eventQueue;
    await flushMessage();

    const presentedOutput = presentedSegments.findLast(
      (segment) => segment.original.trim() === output.trim(),
    );
    if (presentedOutput !== undefined) {
      return presentedOutput.presented;
    }

    const presented = await session.present(output);
    return presented.message ?? "";
  }

  private async requireAgentManagement(): Promise<AgentManagementService> {
    if (this.options.runAgentSessionImpl !== undefined) {
      throw new Error("Agent management is unavailable for an injected Agent Session.");
    }
    await this.initialize();
    if (this.agentManagementService === undefined) {
      throw new Error("CLI Agent Session did not create Agent management.");
    }
    return this.agentManagementService;
  }

  private permissionHandler(
    userApprovalHandler: PermissionApprovalHandler | undefined,
  ): PermissionApprovalHandler {
    return async (request) => {
      const profileDecision = this.configuredPermissionDecision(request);
      const configured =
        this.options.permissionPolicyMode === "external" && profileDecision !== "deny"
          ? "ask"
          : profileDecision;
      if (configured === "allow") {
        return {
          decision: "allow",
          reason: "Allowed by the active Yiku permission profile.",
        };
      }
      if (configured === "deny") {
        return {
          decision: "deny",
          reason: "Denied by the active Yiku permission profile.",
        };
      }
      const sessionKey = sessionPermissionKey(request);
      if (sessionKey !== undefined && this.sessionPermissionGrants.has(sessionKey)) {
        return {
          decision: "allow",
          reason: "Allowed by a previous approval in this Yiku session.",
          scope: "session",
        };
      }
      if (userApprovalHandler === undefined) {
        return {
          decision: "deny",
          reason: "No permission approval handler configured.",
        };
      }

      const requestApproval = async (): Promise<PermissionResponse> => {
        const response = await userApprovalHandler(request);
        if (response.decision === "allow" && response.scope === "session") {
          if (sessionKey !== undefined) {
            this.sessionPermissionGrants.add(sessionKey);
          }
        }
        if (response.decision === "allow" && response.scope === "persistent") {
          const store = this.permissionProfileStore;
          if (store === undefined) {
            throw new Error("Permission Profile Store is unavailable.");
          }
          await store.setPolicyRule(request.policyId, "allow");
          this.permissionRuleMatcher = new PermissionRuleMatcher(await store.load());
        }
        return response;
      };

      if (sessionKey === undefined) {
        return requestApproval();
      }
      const pending = this.pendingPermissionApprovals.get(sessionKey);
      if (pending !== undefined) {
        return pending;
      }

      const approval = requestApproval();
      this.pendingPermissionApprovals.set(sessionKey, approval);
      try {
        return await approval;
      } finally {
        if (this.pendingPermissionApprovals.get(sessionKey) === approval) {
          this.pendingPermissionApprovals.delete(sessionKey);
        }
      }
    };
  }

  private permissionAssessmentHandler(
    externalHandler: PermissionAssessmentHandler | undefined,
  ): PermissionAssessmentHandler {
    return async (request, assessment) => {
      const profileDecision = this.configuredPermissionDecision(request, assessment);
      const configured =
        this.options.permissionPolicyMode === "external" && profileDecision !== "deny"
          ? assessment
          : profileDecision;
      return externalHandler === undefined ? configured : externalHandler(request, configured);
    };
  }

  private configuredPermissionDecision(
    request: PermissionRequest,
    fallback: PermissionAssessment = "ask",
  ): PermissionAssessment {
    return this.permissionRuleMatcher?.resolve(request, fallback) ?? fallback;
  }

  private baseSessionOptions(): AgentSessionClassOptions {
    const {
      continueSession: _continueSession,
      discoverHooks: _discoverHooks,
      mcpServerFactory: _mcpServerFactory,
      migrateLegacy: _migrateLegacy,
      permissionPolicyMode: _permissionPolicyMode,
      resumeSessionId: _resumeSessionId,
      runAgentSessionImpl: _runAgentSessionImpl,
      trustStorePath: _trustStorePath,
      ...sessionOptions
    } = this.options;
    return {
      ...sessionOptions,
      ...(this.options.runAgentSessionImpl === undefined
        ? { workspaceAccessController: this.workspaceAccessController }
        : {}),
    };
  }
}

function resolveRuntimeStorage(bootstrap: CliSessionBootstrapResult): RuntimeStoragePaths {
  return {
    atomicRunsDir: bootstrap.paths.atomicRunsDir,
    evalsDir: bootstrap.paths.evalsDir,
    memoryFilePath: bootstrap.paths.workspaceMemoryFilePath,
    runsDir: bootstrap.paths.runsDir,
    sessionsDir: bootstrap.paths.sessionsDir,
  };
}

function hookConfigDocuments(bootstrap: CliSessionBootstrapResult): HookConfigDocument[] {
  return [
    hookConfigDocument(bootstrap.userConfig.hooks, "user", bootstrap.paths.configFilePath),
    hookConfigDocument(
      bootstrap.projectConfig.hooks,
      "project",
      join(bootstrap.cwd, "config.yaml"),
    ),
  ].filter((document): document is HookConfigDocument => document !== undefined);
}

function hookConfigDocument(
  hooks: unknown,
  sourceType: "project" | "user",
  path: string,
): HookConfigDocument | undefined {
  return isRecord(hooks)
    ? {
        source: hookSource(sourceType, { path }),
        value: { hooks },
      }
    : undefined;
}

function withSharedHookSession(
  options: AgentSessionClassOptions,
  environment: CliSessionBootstrapResult["environment"],
): AgentSessionClassOptions {
  const hooks = options.hooks;
  if (hooks === undefined) {
    return options;
  }

  return {
    ...options,
    hooks: {
      ...hooks,
      hookSession:
        hooks.hookSession ??
        new HookSession({
          engine: hooks.engine,
          environment: {
            ...process.env,
            ...environment,
          },
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }),
    },
  };
}

function isCloseTrustRequiredError(error: unknown): boolean {
  if (isHookTrustRequiredError(error)) {
    return true;
  }
  if (!(error instanceof AggregateError)) {
    return false;
  }
  return error.errors.length > 0 && error.errors.every((item) => isHookTrustRequiredError(item));
}

function isHookTrustRequiredError(error: unknown): boolean {
  return error instanceof HookTrustError && error.code === "HOOK_TRUST_REQUIRED";
}

function configuredAgentTypes(bootstrap: CliSessionBootstrapResult): readonly string[] {
  const graph = resolveAgentGraph(bootstrap.runtimeConfig.modelsConfig);
  return [...new Set(["code", ...[...graph.items.values()].map((agent) => agent.type ?? "code")])];
}

function configuredModelKeys(bootstrap: CliSessionBootstrapResult): readonly string[] {
  const models = bootstrap.runtimeConfig.modelsConfig.models;
  if (!isRecord(models) || !isRecord(models.items)) {
    return [];
  }
  return Object.keys(models.items).toSorted((left, right) => left.localeCompare(right));
}

function configuredModels(
  bootstrap: CliSessionBootstrapResult,
  currentModelKey: string,
): readonly CliModelSummary[] {
  const models = bootstrap.runtimeConfig.modelsConfig.models;
  const items = isRecord(models) && isRecord(models.items) ? models.items : {};
  const modelItems = new Map(Object.entries(items));
  if (!modelItems.has(currentModelKey)) {
    modelItems.set(currentModelKey, {});
  }

  return Object.freeze(
    [...modelItems]
      .map(([key, value]) => {
        const item = isRecord(value) ? value : {};
        const resolved = resolveConfiguredModel(bootstrap, key, item);
        const provider =
          typeof item.provider === "string" && item.provider.trim()
            ? item.provider.trim()
            : providerFromBaseUrl(resolved.baseURL);
        return Object.freeze({
          ...(resolved.contextWindow !== undefined
            ? { contextWindow: resolved.contextWindow }
            : {}),
          ...(resolved.contextWindowSource !== undefined
            ? { contextWindowSource: resolved.contextWindowSource }
            : {}),
          key,
          model: resolved.model,
          ...(provider === undefined ? {} : { provider }),
        });
      })
      .toSorted((left, right) => left.key.localeCompare(right.key)),
  );
}

function resolveConfiguredModel(
  bootstrap: CliSessionBootstrapResult,
  key: string,
  item: Readonly<Record<string, unknown>>,
): {
  readonly baseURL?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly model: string;
} {
  try {
    return resolveModelConfig({
      env: bootstrap.environment,
      modelKey: key,
      modelsConfig: bootstrap.runtimeConfig.modelsConfig,
    });
  } catch {
    return {
      ...(typeof item.baseURL === "string" && item.baseURL.trim()
        ? { baseURL: item.baseURL.trim() }
        : {}),
      model: typeof item.name === "string" && item.name.trim() ? item.name.trim() : key,
    };
  }
}

function providerFromBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function resolveModelExecutors(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  modelKey: string | undefined,
) {
  try {
    const { model, ...clientOptions } = resolveOpenAIModelOptions(
      environment,
      modelsConfig,
      modelKey,
    );
    const modelOptions = {
      ...clientOptions,
      defaultModel: model,
    };

    return [
      new PromptHookExecutor({
        runner: new OpenAIHookModelRunner(modelOptions),
      }),
      new AgentHookExecutor({
        runner: new OpenAIHookAgentRunner(modelOptions),
      }),
    ] as const;
  } catch {
    return [];
  }
}

function lazyAgentProfileGenerator(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  modelKey: string,
): AgentProfileGenerator {
  return {
    generate: (input, options) =>
      new OpenAIAgentProfileGenerator(
        resolveOpenAIModelOptions(environment, modelsConfig, modelKey),
      ).generate(input, options),
  };
}

function lazySkillGenerator(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  modelKey: string,
): SkillGenerator {
  return {
    generate: (intent, options) =>
      new OpenAISkillGenerator(
        resolveOpenAIModelOptions(environment, modelsConfig, modelKey),
      ).generate(intent, options),
  };
}

function resolveContextSummarizer(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  agentKey: string | undefined,
  modelKey: string | undefined,
): OpenAIContextSummarizer | undefined {
  try {
    const graph = resolveAgentGraph(modelsConfig);
    const selectedAgentKey =
      agentKey?.trim() || environment.YIKU_AGENT?.trim() || graph.defaultAgentKey || "code";
    const selectedModelKey = graph.items.get(selectedAgentKey)?.modelKey ?? modelKey;
    return new OpenAIContextSummarizer(
      resolveOpenAIModelOptions(environment, modelsConfig, selectedModelKey),
    );
  } catch {
    return undefined;
  }
}

function resolveMemoryExtractor(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  agentKey: string,
  modelKey: string,
): OpenAIMemoryExtractor | undefined {
  try {
    const graph = resolveAgentGraph(modelsConfig);
    return new OpenAIMemoryExtractor(
      resolveOpenAIModelOptions(
        environment,
        modelsConfig,
        graph.items.get(agentKey)?.modelKey ?? modelKey,
      ),
    );
  } catch {
    return undefined;
  }
}

function resolveOpenAIModelOptions(
  environment: Readonly<Record<string, string | undefined>>,
  modelsConfig: AgentSessionOptions["modelsConfig"],
  modelKey: string | undefined,
) {
  const model = resolveModelConfig({
    env: environment,
    ...(modelKey !== undefined ? { modelKey } : {}),
    modelsConfig,
  });
  return {
    apiKey: model.apiKey,
    ...(model.baseURL !== undefined ? { baseURL: model.baseURL } : {}),
    model: model.model,
  };
}

function createMemoryController(
  memories: AgentSessionMemoryOptions | undefined,
  sessionId: string,
  bootstrap: CliSessionBootstrapResult,
): MemoryController | undefined {
  return memories?.lifecycle === undefined
    ? undefined
    : new MemoryController({
        createFlow: (prompt) =>
          createSessionAtomicFlow({
            endpoint: bootstrap.environment.YIKU_ATOMIC_STUDIO_URL,
            prompt,
            sessionId,
            trace: bootstrap.runtimeConfig.flow.trace,
            workspaceDir: bootstrap.cwd,
          }),
        memories,
        sessionId,
      });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCliSkillCommand(descriptor: SkillDescriptor): CliSkillCommand {
  return Object.freeze({
    description: descriptor.description,
    digest: descriptor.digest,
    name: descriptor.name,
    path: descriptor.path,
    source: descriptor.source,
    version: descriptor.version,
  });
}

function sessionPermissionKey(request: PermissionRequest): string | undefined {
  if (request.metadata?.commandTruncated === "true") {
    return undefined;
  }

  return JSON.stringify({
    capabilities: [...new Set(request.capabilities.map((capability) => capability.trim()))]
      .filter(Boolean)
      .toSorted(),
    normalizedAction: normalizePermissionValue(request.normalizedAction),
    policyId: request.policyId.trim(),
    risk: request.risk,
    target: permissionTarget(request),
    toolName: request.toolName.trim(),
    workspaceId: request.workspaceId.trim(),
  });
}

function permissionTarget(request: PermissionRequest): string {
  if (request.toolName === "bashTool") {
    return normalizePermissionValue(request.subject);
  }
  if (request.policyId === "mcp-external-side-effect") {
    return request.subject.trim();
  }
  return "";
}

function normalizePermissionValue(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}
