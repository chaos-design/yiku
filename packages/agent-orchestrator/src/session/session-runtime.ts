import { isAbsolute, join, relative, resolve } from "node:path";
import {
  normalizeUserQuestionRequest,
  type PermissionApprovalHandler,
  requestPermissionApproval,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "@yiku/agent-code";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import { YikuPaths } from "@yiku/config";
import type { HookDecision } from "@yiku/hooks";
import { MemoryError, type WorkingMemorySource } from "@yiku/memories";
import { Trace } from "@yiku/trajectory";
import { DEFAULT_RUNTIME_BUDGET_CONFIG } from "../config/runtime-config.js";
import type { ResolvedFlowConfig, RuntimeBudgetConfig } from "../config/types.js";
import { AgentEventStore } from "../messages/event-store.js";
import { AgentMessageBus } from "../messages/message-bus.js";
import {
  type AgentMessageCorrelation,
  envelopeToProgressEvent,
  progressEventToEnvelope,
} from "../messages/progress-adapter.js";
import type { AgentMessageEnvelope } from "../messages/types.js";
import type { NotificationMessage } from "../notifications/notifier.js";
import {
  findRuntimeToolInstanceId,
  getSubagentExecutionInstanceId,
  recordRuntimeAtomicEvent,
} from "../runtime/atomic-runtime.js";
import {
  type SessionToolCheckpointStore,
  updateCurrentSessionState,
} from "../runtime/session-tool-middleware.js";
import type {
  AgentContinuationState,
  AgentProgressEvent,
  AgentProgressHandler,
  AgentStopReason,
} from "../runtime/types.js";
import { SessionTaskStore } from "../tasks/task-store.js";
import {
  type CheckpointRecord,
  CheckpointService,
  type CheckpointSnapshotStore,
} from "../workspace/checkpoint-service.js";
import { WorkspaceSnapshotLimitError } from "../workspace/workspace-snapshot-store.js";
import { AgentSession, type AgentSessionClassOptions } from "./agent-session.js";
import { type CreateSessionAtomicFlowOptions, createSessionAtomicFlow } from "./atomic-flow.js";
import { ContextBudget } from "./context-budget.js";
import {
  AgentStageStopError,
  ExecutionPolicy,
  SessionPausedError,
  StageTimeoutError,
} from "./execution-policy.js";
import type { SessionHistoryEntry } from "./history.js";
import type { MessageDisplayResult } from "./message-display.js";
import { PausableDeadline } from "./pausable-deadline.js";
import { parseSessionState, type SessionState } from "./session-state.js";
import type {
  AgentSessionEndReason,
  AgentSessionMemoryOptions,
  AgentSessionOptions,
  AgentSessionSubmitOptions,
} from "./types.js";
import {
  type PendingUserQuestion,
  UserQuestionBroker,
  type UserQuestionLifecycleEvent,
  type UserQuestionPendingResult,
} from "./user-question-broker.js";

export interface SessionResumeReviewRequest {
  readonly operation: SessionState["inFlightOperations"][number];
}

export interface SessionResumeReviewResponse {
  readonly action: "abandon" | "completed" | "retry";
}

export type SessionResumeReviewHandler = (
  request: SessionResumeReviewRequest,
) => Promise<SessionResumeReviewResponse> | SessionResumeReviewResponse;

export interface ProviderContinuationCapability {
  readonly adapter: string;
  readonly pendingQuestion: "reconstructed" | "review-required";
}

export interface SessionRuntimeSubmitOptions extends AgentSessionSubmitOptions {
  readonly onMessage?: ((message: AgentMessageEnvelope) => Promise<void> | void) | undefined;
  readonly resumeReviewHandler?: SessionResumeReviewHandler | undefined;
}

export interface SessionRuntimeSession {
  clear(): Promise<void>;
  close(reason?: AgentSessionEndReason): Promise<void>;
  compact(
    reason: "auto" | "manual",
    maxSummaryChars?: number,
    customInstructions?: string,
  ): Promise<void>;
  historySnapshot(): readonly SessionHistoryEntry[];
  restoreHistory?(entries: readonly SessionHistoryEntry[]): void;
  notify(
    notification: NotificationMessage,
    sink: (notification: NotificationMessage) => Promise<void> | void,
  ): Promise<void>;
  present(message: string): Promise<MessageDisplayResult>;
  setup<T>(
    trigger: "init" | "maintenance",
    operation: () => Promise<T>,
  ): Promise<{ readonly decision?: HookDecision | undefined; readonly result: T }>;
  submit(prompt: string, options?: SessionRuntimeSubmitOptions): Promise<string>;
}

export interface SessionRuntimeResource {
  close(): Promise<void> | void;
}

export interface SessionRuntimeOptions extends AgentSessionClassOptions {
  readonly budgetConfig?: RuntimeBudgetConfig | undefined;
  readonly checkpointSnapshotStore?: CheckpointSnapshotStore | undefined;
  readonly flowConfig?: ResolvedFlowConfig | undefined;
  readonly indexFilePath?: string | undefined;
  readonly notificationSink?:
    | ((notification: NotificationMessage) => Promise<void> | void)
    | undefined;
  readonly onAtomicFlowChange?: ((flow?: AtomicFlowRun) => void) | undefined;
  readonly providerContinuation?: ProviderContinuationCapability | undefined;
  readonly resources?: readonly SessionRuntimeResource[] | undefined;
  readonly resumed?: boolean | undefined;
  readonly session?: SessionRuntimeSession | undefined;
  readonly sessionState?: SessionState | undefined;
  readonly store?: SessionToolCheckpointStore | undefined;
}

type SessionRuntimeStatus = "active" | "closed" | "closing";
type PendingQuestionInput = Extract<
  NonNullable<SessionState["pendingInput"]>,
  { readonly kind: "question" }
>["questions"][number];

const DEFAULT_PROVIDER_CONTINUATION = Object.freeze({
  adapter: "openai-agents",
  pendingQuestion: "reconstructed",
} satisfies ProviderContinuationCapability);

export class SessionRuntime implements SessionRuntimeSession {
  private activeAtomicFlow?: AtomicFlowRun | undefined;
  private activeOnEvent?: AgentProgressHandler | undefined;
  private activeSubmitFinished?: Promise<void> | undefined;
  private activeSubmitController?: AbortController | undefined;
  private activeStageDeadline?: PausableDeadline | undefined;
  private readonly atomicFlowOptions?: Omit<CreateSessionAtomicFlowOptions, "prompt"> | undefined;
  private readonly checkpointService?: CheckpointService | undefined;
  private closePromise?: Promise<void> | undefined;
  private currentStageId = "stage-0";
  private readonly notificationSink: (notification: NotificationMessage) => Promise<void> | void;
  private readonly onAtomicFlowChange?: ((flow?: AtomicFlowRun) => void) | undefined;
  private readonly contextBudget?: ContextBudget | undefined;
  private readonly configuredAtomicFlow?: AtomicFlowRun | undefined;
  private contextWindow?: number | undefined;
  private readonly defaultUserQuestionHandler: AgentSessionSubmitOptions["userQuestionHandler"];
  private readonly memoryOptions?: AgentSessionMemoryOptions | undefined;
  private readonly messageBus?: AgentMessageBus | undefined;
  private readonly messageCorrelation?: AgentMessageCorrelation | undefined;
  private readonly sessionPublishesMessages: boolean;
  private messagePublicationError?: unknown;
  private peakInputTokens?: number | undefined;
  private pendingInputUpdateQueue: Promise<void> = Promise.resolve();
  private readonly pendingMessagePublications = new Set<Promise<void>>();
  private readonly policy?: ExecutionPolicy | undefined;
  private readonly providerContinuation: ProviderContinuationCapability;
  private readonly resources: readonly SessionRuntimeResource[];
  private resumeEventPending: boolean;
  private readonly session: SessionRuntimeSession;
  private state?: SessionState | undefined;
  private status: SessionRuntimeStatus = "active";
  private readonly store?: SessionToolCheckpointStore | undefined;
  private submitting = false;
  private readonly trace?: Trace<AgentProgressEvent> | undefined;
  private readonly userQuestions: UserQuestionBroker;

  public constructor(options: SessionRuntimeOptions = {}) {
    const {
      budgetConfig,
      checkpointSnapshotStore,
      flowConfig,
      indexFilePath,
      notificationSink,
      onAtomicFlowChange,
      providerContinuation = DEFAULT_PROVIDER_CONTINUATION,
      resources = [],
      resumed = false,
      session,
      sessionState,
      store,
      ...sessionOptions
    } = options;
    if ((sessionState === undefined) !== (store === undefined)) {
      throw new Error("Session Runtime state and store must be configured together.");
    }
    this.notificationSink = notificationSink ?? (() => undefined);
    this.onAtomicFlowChange = onAtomicFlowChange;
    this.providerContinuation = Object.freeze({ ...providerContinuation });
    this.policy =
      sessionState === undefined
        ? undefined
        : new ExecutionPolicy(budgetConfig ?? DEFAULT_RUNTIME_BUDGET_CONFIG);
    this.contextBudget =
      sessionState === undefined
        ? undefined
        : new ContextBudget({
            compactAtContextRatio: (budgetConfig ?? DEFAULT_RUNTIME_BUDGET_CONFIG)
              .compactAtContextRatio,
            compactToContextRatio: (budgetConfig ?? DEFAULT_RUNTIME_BUDGET_CONFIG)
              .compactToContextRatio,
            fallbackMaxCharacters: 32_768,
          });
    const defaultMessaging =
      sessionOptions.messageBus === undefined
        ? createDefaultSessionMessaging(sessionOptions, sessionState)
        : undefined;
    this.messageBus = sessionOptions.messageBus ?? defaultMessaging?.messageBus;
    this.messageCorrelation = resolveRuntimeMessageCorrelation(
      sessionOptions.messageCorrelation,
      sessionOptions,
      sessionState,
    );
    this.checkpointService =
      sessionState !== undefined &&
      store !== undefined &&
      checkpointSnapshotStore !== undefined &&
      indexFilePath !== undefined
        ? new CheckpointService({
            indexFilePath,
            ...(this.messageBus !== undefined ? { messageBus: this.messageBus } : {}),
            sessionId: sessionState.sessionId,
            snapshotStore: checkpointSnapshotStore,
          })
        : undefined;
    this.resources = Object.freeze([...resources, ...(defaultMessaging?.resources ?? [])]);
    this.configuredAtomicFlow = sessionOptions.atomicFlow;
    this.defaultUserQuestionHandler = sessionOptions.userQuestionHandler;
    this.memoryOptions = sessionOptions.memories;
    this.resumeEventPending = resumed;
    this.state = sessionState;
    this.store = store;
    const atomicEndpoint = sessionOptions.env?.YIKU_ATOMIC_STUDIO_URL?.trim();
    if (sessionOptions.atomicFlow === undefined && sessionOptions.sessionId !== undefined) {
      this.atomicFlowOptions = {
        ...(sessionOptions.agentKey !== undefined ? { agentKey: sessionOptions.agentKey } : {}),
        ...(sessionOptions.agentName !== undefined ? { agentName: sessionOptions.agentName } : {}),
        ...(sessionOptions.agentType !== undefined ? { agentType: sessionOptions.agentType } : {}),
        atomicRunsDir:
          sessionOptions.runtimeStorage?.atomicRunsDir ??
          new YikuPaths({
            ...(sessionOptions.homeDir !== undefined ? { homeDir: sessionOptions.homeDir } : {}),
            workspaceDir: resolve(sessionOptions.cwd ?? process.cwd()),
          }).atomicRunsDir,
        ...(atomicEndpoint ? { endpoint: atomicEndpoint } : {}),
        sessionId: sessionOptions.sessionId,
        trace: flowConfig?.trace ?? false,
        workspaceDir: resolve(sessionOptions.cwd ?? process.cwd()),
      };
    }
    this.trace =
      sessionOptions.trace ??
      (sessionState === undefined || session !== undefined
        ? undefined
        : new Trace<AgentProgressEvent>(
            join(
              resolve(
                sessionOptions.sessionsDir ??
                  sessionOptions.runtimeStorage?.sessionsDir ??
                  new YikuPaths({
                    ...(sessionOptions.homeDir !== undefined
                      ? { homeDir: sessionOptions.homeDir }
                      : {}),
                    workspaceDir: resolve(sessionOptions.cwd ?? process.cwd()),
                  }).sessionsDir,
              ),
              `${sessionState.sessionId}.jsonl`,
            ),
          ));
    this.userQuestions = new UserQuestionBroker({
      onEvent: (event) => this.handleUserQuestionEvent(event),
    });
    const {
      messageBus: _messageBus,
      messageCorrelation: _messageCorrelation,
      ...ownedSessionOptions
    } = sessionOptions;
    this.sessionPublishesMessages =
      session === undefined &&
      sessionOptions.turnRunner === undefined &&
      this.messageBus !== undefined &&
      this.messageCorrelation !== undefined;
    this.session =
      session ??
      new AgentSession({
        ...ownedSessionOptions,
        ...(this.messageBus !== undefined ? { messageBus: this.messageBus } : {}),
        ...(this.messageCorrelation !== undefined
          ? { messageCorrelation: this.messageCorrelation }
          : {}),
        ...(this.trace !== undefined ? { trace: this.trace } : {}),
        maxParallelReaders:
          sessionOptions.maxParallelReaders ??
          (budgetConfig ?? DEFAULT_RUNTIME_BUDGET_CONFIG).maxParallelReaders,
        ...(sessionState !== undefined ? { initialHistory: sessionState.history.entries } : {}),
        ...(store !== undefined
          ? {
              stageId: () => this.currentStageId,
              taskStore:
                sessionOptions.taskStore ??
                new SessionTaskStore({
                  sessionId: sessionState?.sessionId ?? "",
                  store,
                }),
              toolCheckpointStore: store,
            }
          : {}),
        ...(this.checkpointService !== undefined
          ? { workspaceCheckpointService: this.checkpointService }
          : {}),
      });
  }

  public async clear(): Promise<void> {
    this.assertActive();
    if (this.state !== undefined) {
      await this.memoryOptions?.lifecycle?.clearWorking(this.state.sessionId);
    }
    await this.session.clear();
  }

  public close(reason: AgentSessionEndReason = "other"): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.userQuestions.cancelAll("Session Runtime closed before the question was answered.");
    this.activeSubmitController?.abort(
      new Error("Session Runtime closed during an active submit."),
    );
    const activeSubmitFinished = this.activeSubmitFinished;
    this.status = "closing";
    this.closePromise = Promise.resolve(activeSubmitFinished)
      .then(() => this.closeResources(reason))
      .finally(() => {
        this.status = "closed";
      });
    return this.closePromise;
  }

  public async present(message: string): Promise<MessageDisplayResult> {
    this.assertActive();
    return this.session.present(message);
  }

  public compact(
    reason: "auto" | "manual",
    maxSummaryChars?: number,
    customInstructions?: string,
  ): Promise<void> {
    this.assertActive();
    return this.session.compact(reason, maxSummaryChars, customInstructions);
  }

  public historySnapshot(): readonly SessionHistoryEntry[] {
    return this.session.historySnapshot();
  }

  public stateSnapshot(): SessionState | undefined {
    return this.state;
  }

  public checkpoints(): Promise<readonly CheckpointRecord[]> {
    this.assertActive();
    const checkpointService = this.checkpointService;
    if (checkpointService === undefined) {
      return Promise.reject(new Error("Session Runtime checkpoint service is unavailable."));
    }
    return checkpointService.list();
  }

  public async rewind(id: string): Promise<void> {
    this.assertActive();
    if (this.submitting) {
      throw new Error("Session Runtime cannot rewind during an active submit.");
    }
    const checkpointService = this.checkpointService;
    const store = this.store;
    const currentState = this.state;
    if (checkpointService === undefined || store === undefined || currentState === undefined) {
      throw new Error("Session Runtime checkpoint service is unavailable.");
    }
    const restoreHistory = this.session.restoreHistory;
    if (restoreHistory === undefined) {
      throw new Error("Session Runtime history restore is unavailable.");
    }

    const checkpoint = await checkpointService.restore(id);
    this.state = await updateCurrentSessionState(store, currentState.sessionId, (state) =>
      parseSessionState({
        ...state,
        checkpointHead: checkpoint.id,
        history: {
          entries: checkpoint.historyEntries,
        },
        status: "active",
      }),
    );
    restoreHistory.call(this.session, checkpoint.historyEntries);
  }

  public answerUserQuestion(questionId: string, response: UserQuestionResponse): void {
    this.assertActive();
    this.userQuestions.answer(questionId, response);
  }

  public cancelUserQuestion(questionId: string, reason?: string): void {
    this.assertActive();
    this.userQuestions.cancel(questionId, reason);
  }

  public pendingUserQuestions(): readonly PendingUserQuestion[] {
    return this.userQuestions.snapshot();
  }

  public recordExternalEvent(event: AgentProgressEvent): void {
    this.assertActive();
    this.emitRuntimeEvent(event);
  }

  public childAgentSessionOptions(
    correlation: AgentMessageCorrelation,
  ): Pick<
    AgentSessionOptions,
    "atomicFlow" | "atomicParentInstanceId" | "messageBus" | "messageCorrelation" | "trace"
  > {
    this.assertActive();
    const atomicParentInstanceId =
      this.activeAtomicFlow === undefined
        ? undefined
        : getSubagentExecutionInstanceId(this.activeAtomicFlow, correlation.agentId);
    return {
      ...(this.activeAtomicFlow !== undefined ? { atomicFlow: this.activeAtomicFlow } : {}),
      ...(atomicParentInstanceId !== undefined ? { atomicParentInstanceId } : {}),
      ...(this.messageBus !== undefined ? { messageBus: this.messageBus } : {}),
      messageCorrelation: correlation,
      ...(this.trace !== undefined ? { trace: this.trace } : {}),
    };
  }

  public async notify(
    notification: NotificationMessage,
    sink: (notification: NotificationMessage) => Promise<void> | void,
  ): Promise<void> {
    this.assertActive();
    await this.session.notify(notification, sink);
  }

  public async setup<T>(
    trigger: "init" | "maintenance",
    operation: () => Promise<T>,
  ): Promise<{ readonly decision?: HookDecision | undefined; readonly result: T }> {
    this.assertActive();
    return this.session.setup(trigger, operation);
  }

  public async submit(prompt: string, options: SessionRuntimeSubmitOptions = {}): Promise<string> {
    this.assertActive();
    if (this.submitting) {
      throw new Error("Session Runtime already has an active submit.");
    }
    this.submitting = true;
    this.activeOnEvent = options.onEvent;
    let markSubmitFinished: (() => void) | undefined;
    const submitFinished = new Promise<void>((resolve) => {
      markSubmitFinished = resolve;
    });
    this.activeSubmitFinished = submitFinished;
    const submitController = new AbortController();
    this.activeSubmitController = submitController;
    const submitSignal =
      options.signal === undefined
        ? submitController.signal
        : AbortSignal.any([options.signal, submitController.signal]);
    const unsubscribeMessage =
      options.onMessage === undefined ? undefined : this.messageBus?.subscribe(options.onMessage);
    let ownedAtomicFlow: ReturnType<typeof createSessionAtomicFlow> | undefined;

    try {
      await this.checkpointBeforeTurn(prompt, options.permissionApprovalHandler);
      ownedAtomicFlow =
        options.atomicFlow === undefined && this.atomicFlowOptions !== undefined
          ? createSessionAtomicFlow({
              ...this.atomicFlowOptions,
              prompt,
            })
          : undefined;
      const { onMessage: _onMessage, ...agentSubmitOptions } = options;
      const baseSubmitOptions =
        ownedAtomicFlow === undefined
          ? { ...agentSubmitOptions, signal: submitSignal }
          : { ...agentSubmitOptions, atomicFlow: ownedAtomicFlow, signal: submitSignal };
      const questionHandler = options.userQuestionHandler ?? this.defaultUserQuestionHandler;
      const submitOptions: SessionRuntimeSubmitOptions = {
        ...baseSubmitOptions,
        onEvent: (event) => this.observeSessionEvent(event),
        userQuestionHandler: this.createUserQuestionHandler(questionHandler),
      };
      this.activeAtomicFlow = options.atomicFlow ?? ownedAtomicFlow ?? this.configuredAtomicFlow;
      this.notifyAtomicFlowChange(this.activeAtomicFlow);
      if (this.resumeEventPending && this.state !== undefined) {
        const pendingQuestions =
          this.state.pendingInput?.kind === "question"
            ? this.state.pendingInput.questions
            : undefined;
        this.emitRuntimeEvent({
          ...(pendingQuestions === undefined
            ? {}
            : {
                continuation: pendingQuestions.some(
                  (question) => question.continuation.strategy === "review-required",
                )
                  ? ("review-required" as const)
                  : ("reconstructed-continuation" as const),
                pendingInputIds: pendingQuestions.map((question) => question.questionId),
              }),
          inFlightOperations: this.state.inFlightOperations.length,
          sessionId: this.state.sessionId,
          type: "session_resumed",
        });
        this.resumeEventPending = false;
      }
      const output =
        this.policy === undefined
          ? await this.session.submit(prompt, submitOptions)
          : await this.submitStages(prompt, submitOptions, questionHandler);
      await this.notify(
        {
          message: "Agent run completed.",
          type: "agent_completed",
        },
        this.notificationSink,
      );
      return output;
    } finally {
      try {
        try {
          this.userQuestions.cancelAll("Agent submit ended before the question was answered.");
        } finally {
          try {
            await ownedAtomicFlow?.close();
          } finally {
            try {
              await this.flushMessagePublications();
            } finally {
              unsubscribeMessage?.();
            }
          }
        }
      } finally {
        this.activeAtomicFlow = undefined;
        this.notifyAtomicFlowChange(undefined);
        this.activeOnEvent = undefined;
        if (this.activeSubmitController === submitController) {
          this.activeSubmitController = undefined;
        }
        if (this.activeSubmitFinished === submitFinished) {
          this.activeSubmitFinished = undefined;
        }
        markSubmitFinished?.();
        this.submitting = false;
      }
    }
  }

  private async submitStages(
    initialPrompt: string,
    options: SessionRuntimeSubmitOptions,
    restoredQuestionHandler: AgentSessionSubmitOptions["userQuestionHandler"],
  ): Promise<string> {
    let prompt = initialPrompt;
    let continuationState: AgentContinuationState | undefined;
    await this.resolveInFlightOperations(options.resumeReviewHandler);
    prompt = await this.resolvePendingQuestion(prompt, restoredQuestionHandler);
    await this.checkpoint((state) =>
      state.history.entries.at(-1)?.content === prompt
        ? state
        : parseSessionState({
            ...state,
            history: {
              ...state.history,
              entries: [...state.history.entries, { content: prompt, role: "user" }],
            },
          }),
    );
    if (this.memoryOptions?.lifecycle !== undefined) {
      await this.captureWorking(prompt, "prompt");
    }

    for (;;) {
      const started = await this.checkpoint((state) => this.policy?.startStage(state) ?? state);
      const progressRevisionAtStart = started.budget.progressRevision;
      this.currentStageId = `stage-${started.budget.totalStages}`;
      this.emitRuntimeEvent({
        stage: started.budget.stage,
        stageId: this.currentStageId,
        totalStages: started.budget.totalStages,
        type: "stage_started",
      });
      const timeoutController = new AbortController();
      const deadline = new PausableDeadline(this.runtimeBudget().maxStageDurationMs, () => {
        timeoutController.abort(new StageTimeoutError("Agent stage timed out."));
      });
      this.activeStageDeadline = deadline;
      const signal = combineSignals(options.signal, timeoutController.signal);

      try {
        const output = await this.session.submit(prompt, {
          ...this.observeStage(options),
          ...(continuationState !== undefined ? { continuationState } : {}),
          maxTurns: this.runtimeBudget().maxTurnsPerStage,
          signal,
        });
        await this.syncHistory();
        const decision = await this.finishOutputStage(progressRevisionAtStart);
        if (decision.action === "continue") {
          this.emitStageFinished("continued");
          await this.maybeCompact();
          continuationState = undefined;
          prompt = "Continue working from the persisted task list.";
          continue;
        }
        if (decision.action === "pause") {
          this.emitStageFinished("paused", decision.reason);
          throw new SessionPausedError(decision.reason, decision.state);
        }
        this.emitStageFinished(decision.action === "complete" ? "completed" : "failed");
        return output;
      } catch (error) {
        if (error instanceof SessionPausedError) {
          throw error;
        }
        if (options.signal?.aborted) {
          await this.finishStage("cancelled", progressRevisionAtStart);
          this.emitStageFinished("paused", "cancelled");
          throw error;
        }
        if (error instanceof AgentStageStopError) {
          const decision = await this.finishStage(error.stopReason, progressRevisionAtStart);
          if (decision.action === "continue") {
            if (decision.state.inFlightOperations.length > 0) {
              const needsReview = await this.checkpoint((state) =>
                parseSessionState({ ...state, status: "needs-review" }),
              );
              this.emitStageFinished("paused", "needs-review");
              throw new SessionPausedError("needs-review", needsReview);
            }
            this.emitStageFinished("continued", error.stopReason);
            await this.maybeCompact();
            continuationState = error.continuationState;
            prompt = "Continue working from the saved stage.";
            continue;
          }
          if (decision.action === "pause") {
            this.emitStageFinished("paused", decision.reason);
            throw new SessionPausedError(decision.reason, decision.state);
          }
          this.emitStageFinished("failed", error.stopReason);
        } else if (error instanceof MemoryError) {
          let decision: ReturnType<ExecutionPolicy["pause"]> | undefined;
          await this.checkpoint((state) => {
            decision = this.policy?.pause(state, "memory-error");
            return decision?.state ?? state;
          });
          if (decision === undefined) {
            throw new Error("Session Runtime execution policy is unavailable.");
          }
          this.emitStageFinished("paused", "memory-error");
          throw new SessionPausedError("memory-error", decision.state);
        } else {
          await this.finishStage("provider_error", progressRevisionAtStart);
          this.emitStageFinished("failed", "provider_error");
        }
        throw error;
      } finally {
        deadline.close();
        if (this.activeStageDeadline === deadline) {
          this.activeStageDeadline = undefined;
        }
      }
    }
  }

  private async finishStage(stopReason: AgentStopReason, progressRevisionAtStart: number) {
    let decision: ReturnType<ExecutionPolicy["finishStage"]> | undefined;
    await this.checkpoint((state) => {
      decision = this.policy?.finishStage(state, {
        progressRevisionAtStart,
        stopReason,
      });
      return decision?.state ?? state;
    });
    if (decision === undefined) {
      throw new Error("Session Runtime execution policy is unavailable.");
    }
    this.emitTaskSnapshot(decision.state);
    return decision;
  }

  private async finishOutputStage(progressRevisionAtStart: number) {
    const state = await this.currentState();
    if (this.memoryOptions?.lifecycle !== undefined && state.lastCompletedOperation !== undefined) {
      await this.captureWorking(
        [
          `${state.lastCompletedOperation.toolName}: ${state.lastCompletedOperation.inputSummary}`,
          state.lastCompletedOperation.outputSummary,
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n"),
        "operation",
      );
    }
    if (state.tasks.some((task) => task.status === "blocked")) {
      let decision: ReturnType<ExecutionPolicy["pause"]> | undefined;
      await this.checkpoint((current) => {
        decision = this.policy?.pause(current, "blocked-task");
        return decision?.state ?? current;
      });
      if (decision === undefined) {
        throw new Error("Session Runtime execution policy is unavailable.");
      }
      this.emitTaskSnapshot(decision.state);
      return decision;
    }
    if (state.tasks.some((task) => task.status !== "completed")) {
      return this.finishStage("max_turns", progressRevisionAtStart);
    }
    return this.finishStage("completed", progressRevisionAtStart);
  }

  private observeStage(options: AgentSessionSubmitOptions): AgentSessionSubmitOptions {
    return {
      ...options,
      onContext: (context) => {
        this.contextWindow = context.contextWindow;
        options.onContext?.({
          ...context,
          compactAtContextRatio: this.runtimeBudget().compactAtContextRatio,
        });
      },
    };
  }

  private async resolveInFlightOperations(
    handler: SessionResumeReviewHandler | undefined,
  ): Promise<void> {
    const state = this.state;
    if (state === undefined || state.inFlightOperations.length === 0) {
      return;
    }

    const uncertain = state.inFlightOperations.filter((operation) => operation.effect !== "read");
    if (uncertain.length > 0 && handler === undefined) {
      const paused = await this.checkpoint((current) =>
        parseSessionState({
          ...current,
          pendingInput: {
            kind: "side-effect-review",
            message: "Confirm the result of interrupted side-effect operations.",
          },
          status: "needs-review",
        }),
      );
      throw new SessionPausedError("needs-review", paused);
    }

    for (const operation of uncertain) {
      const response = await handler?.({ operation });
      if (response === undefined) {
        continue;
      }
      await this.checkpoint((current) => {
        const pendingInput =
          current.pendingInput?.kind === "side-effect-review" ? undefined : current.pendingInput;
        const { pendingInput: _pendingInput, ...rest } = current;
        return parseSessionState({
          ...rest,
          ...(pendingInput === undefined ? {} : { pendingInput }),
          inFlightOperations: current.inFlightOperations.filter(
            (candidate) => candidate.callId !== operation.callId,
          ),
          ...(response.action === "completed" || response.action === "abandon"
            ? {
                lastCompletedOperation: {
                  callId: operation.callId,
                  completedAt: new Date().toISOString(),
                  effect: operation.effect,
                  inputSummary: operation.inputSummary,
                  outputSummary:
                    response.action === "completed"
                      ? "Confirmed completed during resume."
                      : "Abandoned during resume.",
                  stageId: operation.stageId,
                  status: response.action === "completed" ? "succeeded" : "failed",
                  toolName: operation.toolName,
                },
              }
            : {}),
          status: "active",
        });
      });
    }

    await this.checkpoint((current) => {
      const pendingInput =
        current.pendingInput?.kind === "side-effect-review" ? undefined : current.pendingInput;
      const { pendingInput: _pendingInput, ...rest } = current;
      return parseSessionState({
        ...rest,
        ...(pendingInput === undefined ? {} : { pendingInput }),
        inFlightOperations: current.inFlightOperations.filter(
          (operation) => operation.effect !== "read",
        ),
        status: "active",
      });
    });
  }

  private async resolvePendingQuestion(
    initialPrompt: string,
    handler: AgentSessionSubmitOptions["userQuestionHandler"],
  ): Promise<string> {
    const pendingInput = this.state?.pendingInput;
    if (pendingInput?.kind !== "question") {
      return initialPrompt;
    }
    if (
      pendingInput.questions.some(
        (question) => question.continuation.strategy === "review-required",
      )
    ) {
      const needsReview = await this.checkpoint((state) =>
        parseSessionState({ ...state, status: "needs-review" }),
      );
      throw new SessionPausedError("needs-review", needsReview);
    }

    const resolved: Array<{
      readonly pending: PendingQuestionInput;
      readonly response: UserQuestionResponse;
    }> = [];
    for (const pending of pendingInput.questions) {
      const restored = this.userQuestions.restore({
        questionId: pending.questionId,
        request: pending.request,
      });
      this.forwardQuestionToHandler(restored, pending.request, handler);
      const response = await restored.response;
      await this.clearPendingQuestion(pending.questionId);
      await this.captureUserAnswer(pending.request, response).catch(() => undefined);
      resolved.push({ pending, response });
    }

    return reconstructedContinuationPrompt(initialPrompt, resolved);
  }

  private async maybeCompact(): Promise<void> {
    const budget = this.contextBudget;
    if (budget === undefined) {
      return;
    }
    const history = this.session.historySnapshot();
    const decision = budget.evaluate({
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      historyCharacters: history.reduce((total, entry) => total + entry.content.length, 0),
      ...(this.peakInputTokens !== undefined ? { peakInputTokens: this.peakInputTokens } : {}),
    });
    if (!decision.shouldCompact) {
      return;
    }

    await this.session.compact("auto", decision.maxSummaryChars);
    this.peakInputTokens = undefined;
    await this.syncHistory();
    this.emitRuntimeEvent({
      afterEntries: this.session.historySnapshot().length,
      beforeEntries: history.length,
      type: "context_compacted",
    });
  }

  private async syncHistory(): Promise<void> {
    const entries = this.session.historySnapshot();
    await this.checkpoint((state) =>
      parseSessionState({
        ...state,
        history: {
          entries,
        },
      }),
    );
  }

  private async checkpointBeforeTurn(
    prompt: string,
    permissionApprovalHandler: PermissionApprovalHandler | undefined,
  ): Promise<void> {
    const checkpointService = this.checkpointService;
    const store = this.store;
    const currentState = this.state;
    if (checkpointService === undefined || store === undefined || currentState === undefined) {
      return;
    }

    const current = await store.load(currentState.sessionId);
    this.state = current;
    let checkpoint: CheckpointRecord;
    try {
      checkpoint = await checkpointService.beforeTurn({
        historyEntries: this.session.historySnapshot(),
        prompt,
        sessionRevision: current.revision,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceSnapshotLimitError)) {
        throw error;
      }
      await requestPermissionApproval(
        {
          action: "execute without rewindable checkpoint",
          capabilities: ["workspace.checkpoint.bypass"],
          metadata: {
            actual: String(error.actual),
            limit: String(error.maximum),
            limitKind: error.kind,
          },
          normalizedAction: "execute Session turn without a rewindable workspace checkpoint",
          policyId: "workspace-checkpoint-limit",
          reason:
            `The workspace snapshot exceeds the ${error.kind} limit ` +
            `(${error.actual} > ${error.maximum}).`,
          risk: "high",
          subject: prompt,
          toolName: "sessionTurn",
          workspaceId: current.workspaceDir,
        },
        {
          ...(permissionApprovalHandler !== undefined
            ? { approvalHandler: permissionApprovalHandler }
            : {}),
          assessment: "ask",
          defaultDecision: "deny",
        },
      );
      return;
    }
    this.state = await updateCurrentSessionState(store, current.sessionId, (state) =>
      parseSessionState({
        ...state,
        checkpointHead: checkpoint.id,
      }),
    );
  }

  private checkpoint(update: (state: SessionState) => SessionState): Promise<SessionState> {
    const store = this.store;
    const currentState = this.state;
    if (store === undefined || currentState === undefined) {
      return Promise.reject(new Error("Session Runtime checkpoint store is unavailable."));
    }

    return updateCurrentSessionState(store, currentState.sessionId, update).then((saved) => {
      this.state = saved;
      this.emitRuntimeEvent({
        checkpointRevision: saved.revision,
        sessionStatus: saved.status,
        stageId: this.currentStageId,
        type: "checkpoint_saved",
      });
      return saved;
    });
  }

  private currentState(): Promise<SessionState> {
    if (this.store === undefined || this.state === undefined) {
      return Promise.reject(new Error("Session Runtime checkpoint store is unavailable."));
    }
    return this.store.load(this.state.sessionId);
  }

  private runtimeBudget(): RuntimeBudgetConfig {
    const policy = this.policy;
    if (policy === undefined) {
      throw new Error("Session Runtime execution policy is unavailable.");
    }
    return policy.config();
  }

  private emitRuntimeEvent(event: AgentProgressEvent): void {
    this.trace?.record(event);
    if (this.activeAtomicFlow !== undefined) {
      recordRuntimeAtomicEvent(
        this.activeAtomicFlow,
        event,
        event.type === "subagent_spawned"
          ? findRuntimeToolInstanceId(this.activeAtomicFlow, event.parentToolCallId)
          : undefined,
      );
    }
    this.publishProgressEvent(event);
  }

  private observeSessionEvent(event: AgentProgressEvent): void {
    if (event.type === "usage_updated") {
      this.peakInputTokens = Math.max(this.peakInputTokens ?? 0, event.usage.peakInputTokens);
    }
    if (this.sessionPublishesMessages) {
      this.activeOnEvent?.(event);
      return;
    }
    this.publishProgressEvent(event);
  }

  private publishProgressEvent(event: AgentProgressEvent): void {
    const messageBus = this.messageBus;
    const correlation = this.messageCorrelation;
    if (messageBus === undefined || correlation === undefined) {
      this.activeOnEvent?.(event);
      return;
    }

    const envelope = progressEventToEnvelope(event, correlation);
    const publication = messageBus.publish(envelope);
    this.pendingMessagePublications.add(publication);
    void publication.then(
      () => this.pendingMessagePublications.delete(publication),
      (error: unknown) => {
        this.messagePublicationError ??= error;
        this.pendingMessagePublications.delete(publication);
      },
    );
    this.activeOnEvent?.(envelopeToProgressEvent(envelope) ?? event);
  }

  private async flushMessagePublications(): Promise<void> {
    await Promise.allSettled([...this.pendingMessagePublications]);
    let flushError: unknown;
    try {
      await this.messageBus?.flush();
    } catch (error) {
      flushError = error;
    }
    const error = this.messagePublicationError ?? flushError;
    this.messagePublicationError = undefined;
    if (error !== undefined) {
      throw error;
    }
  }

  private createUserQuestionHandler(
    legacyHandler: AgentSessionSubmitOptions["userQuestionHandler"],
  ): NonNullable<AgentSessionSubmitOptions["userQuestionHandler"]> {
    return async (request) => {
      const pending = this.userQuestions.request(request);
      try {
        await this.persistPendingQuestion(pending);
      } catch (error) {
        if (this.isUserQuestionPending(pending.questionId)) {
          this.userQuestions.cancel(pending.questionId, getErrorMessage(error));
        }
        throw error;
      }
      this.forwardQuestionToHandler(pending, request, legacyHandler);
      const response = await pending.response;
      await this.clearPendingQuestion(pending.questionId);
      await this.captureUserAnswer(request, response).catch(() => undefined);
      return response;
    };
  }

  private forwardQuestionToHandler(
    pending: UserQuestionPendingResult,
    request: UserQuestionRequest,
    handler: AgentSessionSubmitOptions["userQuestionHandler"],
  ): void {
    if (handler === undefined) {
      return;
    }
    void Promise.resolve()
      .then(() => handler(request))
      .then(
        (response) => {
          if (this.isUserQuestionPending(pending.questionId)) {
            this.userQuestions.answer(pending.questionId, response);
          }
        },
        (error: unknown) => {
          if (this.isUserQuestionPending(pending.questionId)) {
            this.userQuestions.cancel(pending.questionId, getErrorMessage(error));
          }
        },
      );
  }

  private async persistPendingQuestion(pending: UserQuestionPendingResult): Promise<void> {
    if (this.state === undefined || this.store === undefined) {
      return;
    }
    const question = this.requirePendingQuestion(pending.questionId);
    const strategy =
      this.providerContinuation.pendingQuestion === "review-required" ||
      requiresQuestionReview(question.request)
        ? "review-required"
        : "reconstructed";
    const record: PendingQuestionInput = {
      continuation: {
        adapter: this.providerContinuation.adapter,
        strategy,
      },
      createdAt: new Date().toISOString(),
      questionId: pending.questionId,
      request: question.request,
      stageId: this.currentStageId,
      ...(question.request.toolCallId === undefined
        ? {}
        : { toolCallId: question.request.toolCallId }),
    };
    await this.enqueuePendingInputUpdate(() =>
      this.checkpoint((state) => {
        if (state.pendingInput !== undefined && state.pendingInput.kind !== "question") {
          throw new Error("Session already has a different pending input.");
        }
        const questions =
          state.pendingInput?.kind === "question" ? state.pendingInput.questions : [];
        return parseSessionState({
          ...state,
          pendingInput: {
            kind: "question",
            questions: questions.some((candidate) => candidate.questionId === pending.questionId)
              ? questions
              : [...questions, record],
          },
          status: "paused",
        });
      }),
    );
  }

  private async clearPendingQuestion(questionId: string): Promise<void> {
    if (this.state === undefined || this.store === undefined) {
      return;
    }
    await this.enqueuePendingInputUpdate(() =>
      this.checkpoint((state) => {
        if (state.pendingInput?.kind !== "question") {
          return state;
        }
        const questions = state.pendingInput.questions.filter(
          (question) => question.questionId !== questionId,
        );
        if (questions.length === state.pendingInput.questions.length) {
          return state;
        }
        if (questions.length > 0) {
          return parseSessionState({
            ...state,
            pendingInput: {
              kind: "question",
              questions,
            },
            status: "paused",
          });
        }
        const { pendingInput: _pendingInput, ...rest } = state;
        return parseSessionState({
          ...rest,
          status:
            state.status === "paused" || state.status === "needs-review" ? "active" : state.status,
        });
      }),
    );
  }

  private enqueuePendingInputUpdate(operation: () => Promise<unknown>): Promise<void> {
    const result = this.pendingInputUpdateQueue.then(operation, operation).then(() => undefined);
    this.pendingInputUpdateQueue = result.catch(() => undefined);
    return result;
  }

  private async captureUserAnswer(
    request: UserQuestionRequest,
    response: UserQuestionResponse,
  ): Promise<void> {
    if (this.memoryOptions?.lifecycle === undefined || requiresQuestionReview(request)) {
      return;
    }
    await this.captureWorking(summarizeUserQuestionResponse(response), "user-answer");
  }

  private requirePendingQuestion(questionId: string): PendingUserQuestion {
    const pending = this.userQuestions
      .snapshot()
      .find((question) => question.questionId === questionId);
    if (pending === undefined) {
      throw new Error(`User question was not found: ${questionId}.`);
    }
    return pending;
  }

  private handleUserQuestionEvent(event: UserQuestionLifecycleEvent): void {
    switch (event.type) {
      case "requested":
        if (this.userQuestions.snapshot().length === 1) {
          this.activeStageDeadline?.pause();
        }
        this.emitRuntimeEvent({
          questionId: event.questionId,
          request: event.request,
          type: "user_question_requested",
        });
        return;
      case "resolved":
        if (this.userQuestions.snapshot().length === 0) {
          this.activeStageDeadline?.resume();
        }
        this.emitRuntimeEvent({
          questionId: event.questionId,
          ...(event.selectedIndex !== undefined ? { selectedIndex: event.selectedIndex } : {}),
          type: "user_question_resolved",
        });
        return;
      case "cancelled":
        if (this.userQuestions.snapshot().length === 0) {
          this.activeStageDeadline?.resume();
        }
        this.emitRuntimeEvent({
          questionId: event.questionId,
          reason: event.reason,
          type: "user_question_cancelled",
        });
        return;
    }
  }

  private isUserQuestionPending(questionId: string): boolean {
    return this.userQuestions.snapshot().some((question) => question.questionId === questionId);
  }

  private notifyAtomicFlowChange(flow: AtomicFlowRun | undefined): void {
    try {
      this.onAtomicFlowChange?.(flow);
    } catch {
      // Atomic Flow observers cannot change Session execution.
    }
  }

  private emitStageFinished(
    outcome: Extract<AgentProgressEvent, { type: "stage_finished" }>["outcome"],
    reason?: string,
  ): void {
    this.emitRuntimeEvent({
      outcome,
      ...(reason !== undefined ? { reason } : {}),
      stageId: this.currentStageId,
      type: "stage_finished",
    });
  }

  private emitTaskSnapshot(state: SessionState): void {
    const count = (status: SessionState["tasks"][number]["status"]) =>
      state.tasks.filter((task) => task.status === status).length;
    this.emitRuntimeEvent({
      blocked: count("blocked"),
      completed: count("completed"),
      inProgress: count("in_progress"),
      pending: count("pending"),
      type: "task_snapshot",
    });
    const summary = state.tasks.map((task) => `[${task.status}] ${task.subject}`).join("\n");
    if (summary && this.memoryOptions?.lifecycle !== undefined) {
      void this.captureWorking(summary, "task").catch(() => undefined);
    }
  }

  private async closeResources(reason: AgentSessionEndReason): Promise<void> {
    const errors: unknown[] = [];

    if (
      this.state !== undefined &&
      (reason === "clear" || reason === "logout" || reason === "prompt_input_exit")
    ) {
      try {
        await this.memoryOptions?.lifecycle?.clearWorking(this.state.sessionId);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await this.flushMessagePublications();
    } catch (error) {
      errors.push(error);
    }

    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await this.session.close(reason);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Session Runtime cleanup failed.");
    }
  }

  private assertActive(): void {
    if (this.status !== "active") {
      throw new Error(`Session Runtime is ${this.status}.`);
    }
  }

  private async captureWorking(content: string, source: WorkingMemorySource): Promise<void> {
    const lifecycle = this.memoryOptions?.lifecycle;
    const state = this.state;
    if (lifecycle === undefined || state === undefined || !content.trim()) {
      return;
    }
    const parentInstanceId = this.activeAtomicFlow
      ?.snapshot()
      .events.findLast((event) => event.internal !== true)?.instance.id;
    try {
      await lifecycle.captureWorking({
        ...(this.activeAtomicFlow !== undefined ? { atomicFlow: this.activeAtomicFlow } : {}),
        ...(parentInstanceId !== undefined ? { atomicParentInstanceId: parentInstanceId } : {}),
        content,
        sessionId: state.sessionId,
        source,
      });
    } catch (error) {
      try {
        this.memoryOptions?.onError?.(
          error instanceof MemoryError
            ? error
            : new MemoryError("MEMORY_STORE_UNAVAILABLE", "Working Memory capture failed.", {
                cause: error,
                operation: "capture",
              }),
        );
      } catch {
        // Reporting callbacks cannot change capture behavior.
      }
      if (this.memoryOptions?.failureMode === "strict") {
        throw error;
      }
    }
  }
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

function createDefaultSessionMessaging(
  options: AgentSessionClassOptions,
  state: SessionState | undefined,
):
  | {
      readonly messageBus: AgentMessageBus;
      readonly resources: readonly SessionRuntimeResource[];
    }
  | undefined {
  const configuredSessionsDir = options.sessionsDir ?? options.runtimeStorage?.sessionsDir;
  if (state === undefined || configuredSessionsDir === undefined) {
    return undefined;
  }

  const workspaceDir = resolve(options.cwd ?? process.cwd());
  const sessionsDir = resolve(workspaceDir, configuredSessionsDir);
  const eventStore = new AgentEventStore({
    filePath: resolveSessionEventLogPath(sessionsDir, state.eventLogPath),
  });
  const messageBus = new AgentMessageBus({
    sinks: [
      {
        kind: "required",
        publish: (message) => eventStore.publish(message),
      },
    ],
  });

  return {
    messageBus,
    resources: [
      eventStore,
      {
        close: () => messageBus.flush(),
      },
    ],
  };
}

function resolveSessionEventLogPath(sessionsDir: string, eventLogPath: string): string {
  const normalizedPath = eventLogPath.trim();
  if (!normalizedPath || isAbsolute(normalizedPath)) {
    throw new Error("Session event log path must be relative to the Sessions directory.");
  }

  const resolvedSessionsDir = resolve(sessionsDir);
  const resolvedEventLogPath = resolve(resolvedSessionsDir, normalizedPath);
  const relativePath = relative(resolvedSessionsDir, resolvedEventLogPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Session event log path must stay within the Sessions directory.");
  }

  return resolvedEventLogPath;
}

function resolveRuntimeMessageCorrelation(
  configured: AgentMessageCorrelation | undefined,
  options: AgentSessionClassOptions,
  state: SessionState | undefined,
): AgentMessageCorrelation | undefined {
  const configuredSessionId = options.sessionId?.trim();
  const sessionId =
    state?.sessionId ??
    (configuredSessionId ? configuredSessionId.replace(/[^a-zA-Z0-9._-]/gu, "-") : undefined) ??
    configured?.sessionId;
  if (sessionId === undefined) {
    return undefined;
  }

  if (configured !== undefined) {
    return {
      ...configured,
      sessionId,
    };
  }

  return {
    agentId: state?.agentKey ?? (options.agentKey?.trim() || "root"),
    sessionId,
  };
}

function requiresQuestionReview(request: UserQuestionRequest): boolean {
  return normalizeUserQuestionRequest(request).questions.some(
    (question) => question.risk === "permission" || question.risk === "secret",
  );
}

function reconstructedContinuationPrompt(
  initialPrompt: string,
  resolved: readonly {
    readonly pending: PendingQuestionInput;
    readonly response: UserQuestionResponse;
  }[],
): string {
  const interactions = resolved
    .map(({ pending, response }, index) => {
      const questions = normalizeUserQuestionRequest(pending.request)
        .questions.map((question) => question.question)
        .join("\n");
      return [
        `Pending interaction ${index + 1}:`,
        `Provider adapter: ${pending.continuation.adapter}.`,
        `Persisted question:\n${questions}`,
        `User answer:\n${summarizeUserQuestionResponse(response)}`,
      ].join("\n");
    })
    .join("\n\n");
  return [
    "Continue the interrupted task using a reconstructed continuation.",
    "The original provider Tool Calls were not serialized or resumed.",
    interactions,
    `Resume request:\n${initialPrompt}`,
    "Re-check current state before any side effect and do not claim that the original Tool Calls completed.",
  ].join("\n\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeUserQuestionResponse(response: UserQuestionResponse): string {
  return "answer" in response
    ? response.answer
    : response.answers.flatMap((answer) => answer.answers).join("; ");
}
