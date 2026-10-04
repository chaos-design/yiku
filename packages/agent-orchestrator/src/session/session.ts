import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Agent } from "@openai/agents";
import {
  assessBashCommandRisk,
  CodeArtifactCollector,
  createCodeEvaluators,
  formatAgentOutput,
  type UserQuestionResponse,
  VerificationCommandRunner,
  WorkspaceAccessController,
  WorkspaceContext,
} from "@yiku/agent-code";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import {
  type EnvVars,
  loadEnvFile,
  loadModelsConfig,
  type ModelsConfig,
  mergeConfig,
  mergeEnv,
  YikuPaths,
} from "@yiku/config";
import {
  type AgentArtifactRef,
  DEFAULT_CHECK_EVALUATORS,
  EvalPlanner,
  EvalRunner,
  EvalScheduler,
  EvaluatorRegistry,
  FileEvalResultStore,
  sha256Text,
} from "@yiku/evals";
import {
  DEFAULT_MEMORY_POLICY,
  MEMORY_ATOMS,
  MEMORY_CLASS_ATOMS,
  MemoryError,
  MemoryStoreError,
  memoryClassForKind,
  renderMemoryContext,
  renderMemorySearchContext,
} from "@yiku/memories";
import { Trace } from "@yiku/trajectory";
import { getAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { AgentOutputValidationError, buildCodeAgentGraph } from "../agents/code-agent-graph.js";
import { resolveAgentGraph, resolveModelConfig } from "../config/index.js";
import {
  EvaluationCoordinator,
  EvaluationGateError,
  type EvaluationRepairResult,
} from "../evals/index.js";
import {
  type AgentMessageCorrelation,
  envelopeToProgressEvent,
  progressEventToEnvelope,
} from "../messages/progress-adapter.js";
import {
  composePromptContext,
  extractProjectPromptInstructions,
  PromptGuard,
  type PromptSegment,
} from "../prompt/index.js";
import {
  findRuntimeToolInstanceId,
  getSubagentExecutionInstanceId,
  recordRuntimeAtomicEvent,
} from "../runtime/atomic-runtime.js";
import { RUNTIME_ATOMS } from "../runtime/atoms.js";
import { run } from "../runtime/index.js";
import { HookPermissionApproval } from "../runtime/permission-hooks.js";
import {
  type SessionToolCheckpointRequest,
  SessionToolMiddleware,
} from "../runtime/session-tool-middleware.js";
import { ToolBatchTracker } from "../runtime/tool-batch.js";
import { ToolHookMiddleware } from "../runtime/tool-hooks.js";
import type { AgentProgressEvent } from "../runtime/types.js";
import { createAgentManagementSkill } from "../skills/agent-management-skill.js";
import { CapabilityScope } from "../skills/capability-scope.js";
import { createSkillRuntimeSkill } from "../skills/skill-runtime-skill.js";
import { SkillWorker } from "../skills/skill-worker.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import { WorkspaceWriteLock } from "../tasks/write-lock.js";
import { delegateTaskTool } from "../tools/delegate-tool.js";
import { mcpTools } from "../tools/mcp-tool.js";
import { CwdTracker } from "../workspace/cwd-tracker.js";
import { WorktreeManager } from "../workspace/worktree-manager.js";
import { createSessionAtomicFlow } from "./atomic-flow.js";
import { AgentStageStopError } from "./execution-policy.js";
import { startMemoryProgress } from "./memory-progress.js";
import type { RuntimeStoragePaths } from "./runtime-storage.js";
import type {
  AgentContextComposition,
  AgentSessionContext,
  AgentSessionMemoryOptions,
  AgentSessionOptions,
} from "./types.js";

interface ResolvedSession {
  readonly additionalInstructions?: string | undefined;
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly context: AgentSessionContext;
  readonly env: EnvVars;
  readonly instructions?: string | undefined;
  readonly memoryContext?: string | undefined;
  readonly memoryContextCharacters?:
    | Readonly<Record<"procedure" | "scenario" | "semantic" | "working", number>>
    | undefined;
  readonly modelsConfig: ModelsConfig;
  readonly promptSegments: readonly PromptSegment[];
  readonly storage: RuntimeStoragePaths;
}

interface BuiltAgentGraph {
  readonly agent: Agent;
  readonly close: () => void;
  readonly contextComposition: AgentContextComposition;
  readonly flushToolBatch: () => Promise<void>;
  readonly promptSegments: readonly PromptSegment[];
}

interface IndustrialEvaluationRuntime {
  readonly codeCollector?: CodeArtifactCollector | undefined;
  readonly codeInitialSnapshot?: Awaited<ReturnType<CodeArtifactCollector["capture"]>> | undefined;
  readonly commandRunner?: VerificationCommandRunner | undefined;
  readonly coordinator: EvaluationCoordinator;
  close(): Promise<void>;
  snapshot(
    output: string,
  ): Promise<Pick<EvaluationRepairResult, "artifacts" | "researchClaimManifest">>;
}

export async function runAgentSession(
  prompt: string,
  options: AgentSessionOptions = {},
): Promise<string> {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession(options);
  let reason: import("./types.js").AgentSessionEndReason = "other";

  try {
    const output = await session.submit(prompt);
    reason = "prompt_input_exit";
    return output;
  } finally {
    await session.close(reason);
  }
}

export async function runAgentSessionTurn(
  prompt: string,
  options: AgentSessionOptions = {},
): Promise<string> {
  const resolvedSession = resolveAgentSession(prompt, options);
  const atomicFlow =
    options.atomicFlow ??
    createSessionAtomicFlow({
      agentKey: resolvedSession.context.agentKey,
      agentName: resolvedSession.context.agentName,
      agentType: resolvedSession.context.agentType,
      atomicRunsDir: resolvedSession.storage.atomicRunsDir,
      endpoint: resolvedSession.env.YIKU_ATOMIC_STUDIO_URL,
      prompt,
      sessionId: resolvedSession.context.sessionId,
      workspaceDir: resolvedSession.context.workspaceDir,
    });
  const ownsAtomicFlow = options.atomicFlow === undefined;
  const existingEvents = atomicFlow.snapshot().events;
  const parentEvent =
    options.atomicParentInstanceId === undefined
      ? existingEvents.findLast((event) => event.atom.key === RUNTIME_ATOMS.stageStart.key)
      : existingEvents.findLast(
          (event) =>
            event.instance.id === options.atomicParentInstanceId &&
            (event.phase === "end" || event.phase === "start"),
        );
  if (options.atomicParentInstanceId !== undefined && parentEvent === undefined) {
    throw new Error(`Atomic parent instance not found: ${options.atomicParentInstanceId}.`);
  }
  const inputSpan = atomicFlow.start({
    atom: RUNTIME_ATOMS.inputPrompt,
    ...(parentEvent !== undefined
      ? {
          edge: {
            fromAtomKey: parentEvent.atom.key,
            kind: "execution" as const,
            toAtomKey: RUNTIME_ATOMS.inputPrompt.key,
          },
          parentInstanceId: parentEvent.instance.id,
        }
      : {}),
    payload: {
      counts: {
        characters: prompt.length,
      },
    },
  });
  inputSpan.end();
  const evaluationRunId = resolveEvaluationRunId(atomicFlow.runId, existingEvents);
  const trace =
    options.trace ?? new Trace<AgentProgressEvent>(resolvedSession.context.traceFilePath);
  const messageCorrelation = resolveMessageCorrelation(
    options.messageCorrelation,
    resolvedSession.context,
  );
  const eventDispatcher = createTraceEventHandler(trace, {
    correlation: messageCorrelation,
    messageBus: options.messageBus,
    onEvent: options.onEvent,
  });
  const onEvent = eventDispatcher.emit;
  const startedAtMs = Date.now();
  const startedRssBytes = process.memoryUsage().rss;
  onEvent({
    agentName: resolvedSession.context.agentName,
    model: resolvedSession.context.model,
    prompt,
    sessionId: resolvedSession.context.sessionId,
    startedAt: new Date(startedAtMs).toISOString(),
    type: "session_started",
    workspaceDir: resolvedSession.context.workspaceDir,
  });
  let session: ResolvedSession;
  try {
    session = await attachRecalledMemories(
      resolvedSession,
      prompt,
      options,
      atomicFlow,
      inputSpan.instanceId,
      onEvent,
    );
    await captureWorkingPrompt(
      prompt,
      session.context.sessionId,
      options,
      atomicFlow,
      inputSpan.instanceId,
      onEvent,
    );
  } catch (error) {
    emitSessionFailure(onEvent, resolvedSession.context.sessionId, startedAtMs, error);
    if (ownsAtomicFlow) {
      await atomicFlow.close();
    }
    await eventDispatcher.flush();
    throw error;
  }
  let graph: BuiltAgentGraph;
  let composedPrompt: ReturnType<typeof composePromptContext>;
  let closePreparedGraph: () => void = () => undefined;
  try {
    graph = await buildSessionAgentGraph(
      session,
      options,
      atomicFlow,
      onEvent,
      eventDispatcher.emitLegacy,
      messageCorrelation,
    );
    closePreparedGraph = () => graph.close();
    composedPrompt = composePromptContext({
      guard: options.promptGuard,
      prompt,
      segments: [...session.promptSegments, ...graph.promptSegments],
    });
    options.onContext?.({
      ...session.context,
      contextComposition: graph.contextComposition,
    });
  } catch (error) {
    closePreparedGraph();
    emitSessionFailure(onEvent, session.context.sessionId, startedAtMs, error);
    if (ownsAtomicFlow) {
      await atomicFlow.close();
    }
    await eventDispatcher.flush();
    throw error;
  }
  const closeGraph = () => graph.close();
  let industrialEvaluation: IndustrialEvaluationRuntime | undefined;

  options.signal?.addEventListener("abort", closeGraph, { once: true });
  if (composedPrompt.findings.length > 0) {
    onEvent({
      findings: composedPrompt.findings,
      type: "prompt_risk_detected",
    });
  }
  try {
    industrialEvaluation = await createIndustrialEvaluationRuntime(session, options, graph);
    const runImpl = options.runImpl ?? run;
    const runOptions = {
      apiKey: session.apiKey,
      atomicEntryInstanceId: inputSpan.instanceId,
      atomicFlow,
      ...(session.baseURL ? { baseURL: session.baseURL } : {}),
      beforeModelCall: graph.flushToolBatch,
      ...(options.continuationState !== undefined
        ? { continuationState: options.continuationState }
        : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      model: session.context.model,
      onEvent,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await runImpl(graph.agent, composedPrompt.input, runOptions);
    await graph.flushToolBatch();
    const output = formatAgentOutput(result.finalOutput);

    if (result.usage !== undefined) {
      onEvent({
        model: session.context.model,
        type: "usage_updated",
        usage: result.usage,
      });
    }

    const stopReason = result.stopReason ?? "completed";
    if (stopReason !== "completed") {
      if (stopReason === "provider_error") {
        throw new Error("Agent provider failed without an error.");
      }
      if (stopReason === "cancelled") {
        onEvent({
          durationMs: Date.now() - startedAtMs,
          finishedAt: new Date().toISOString(),
          reason: abortReason(options.signal),
          sessionId: session.context.sessionId,
          type: "session_cancelled",
        });
      }
      throw new AgentStageStopError({
        ...(result.continuationState !== undefined
          ? { continuationState: result.continuationState }
          : {}),
        stopReason,
      });
    }

    if (result.outputValidation?.passed === false) {
      throw new AgentOutputValidationError(result.outputValidation.diagnostics);
    }
    let finalOutput = output;
    if (industrialEvaluation === undefined) {
      await ingestSessionMemories(session, prompt, finalOutput, options, atomicFlow, onEvent);
      await evaluateSession(finalOutput, options, atomicFlow);
    } else {
      await atomicFlow.flush();
      const evaluationData = await industrialEvaluation.snapshot(finalOutput);
      const outcome = await industrialEvaluation.coordinator.run({
        ...evaluationData,
        atomicFlow,
        finalOutput,
        flow: atomicFlow.snapshot(),
        flowRef: `atomic:${atomicFlow.runId}`,
        repair:
          options.evals?.repair === false
            ? undefined
            : async ({ decision }) => {
                const repairPrompt = [
                  "Repair the previous result so every failed evaluation check passes.",
                  decision.repairInstruction?.feedback ?? decision.reasons.join("\n"),
                  `Original request: ${prompt}`,
                ].join("\n\n");
                const repaired = await runImpl(graph.agent, repairPrompt, {
                  ...runOptions,
                  continuationState: undefined,
                });
                await graph.flushToolBatch();
                const repairedOutput = formatAgentOutput(repaired.finalOutput);
                const repairedStopReason = repaired.stopReason ?? "completed";
                if (repairedStopReason !== "completed") {
                  if (repairedStopReason === "provider_error") {
                    throw new Error("Agent provider failed during evaluation repair.");
                  }
                  throw new AgentStageStopError({
                    ...(repaired.continuationState !== undefined
                      ? { continuationState: repaired.continuationState }
                      : {}),
                    stopReason: repairedStopReason,
                  });
                }
                if (repaired.outputValidation?.passed === false) {
                  throw new AgentOutputValidationError(repaired.outputValidation.diagnostics);
                }
                if (repaired.usage !== undefined) {
                  onEvent({
                    model: session.context.model,
                    type: "usage_updated",
                    usage: repaired.usage,
                  });
                }
                await atomicFlow.flush();
                return {
                  ...(await industrialEvaluation?.snapshot(repairedOutput)),
                  finalOutput: repairedOutput,
                  flow: atomicFlow.snapshot(),
                  operationReceipts: [],
                  runtimeMetrics: sessionRuntimeMetrics(startedAtMs, startedRssBytes),
                } as EvaluationRepairResult;
              },
        runId: evaluationRunId,
        runtimeMetrics: sessionRuntimeMetrics(startedAtMs, startedRssBytes),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        taskId: session.context.sessionId,
        taskSnapshotRef: `session:${session.context.sessionId}`,
      });
      finalOutput = outcome.finalOutput;
      onEvent({
        attempts: outcome.attempts.length,
        counts: outcome.scorecard.counts,
        decision: outcome.decision.action === "retry" ? "needs-review" : outcome.decision.action,
        failedChecks: outcome.scorecard.results.flatMap((result) =>
          result.status === "passed"
            ? []
            : [
                {
                  id: result.id,
                  status: result.status,
                  summary: result.summary,
                },
              ],
        ),
        grade: outcome.scorecard.grade,
        overallScore: outcome.scorecard.overallScore,
        type: "evaluation_finished",
      });
      try {
        options.evals?.onOutcome?.(outcome);
      } catch {
        // Evaluation observers cannot change the Agent result.
      }
      if (
        options.evals?.profile?.mode === "enforce" &&
        outcome.decision.action !== "accepted" &&
        outcome.decision.action !== "degraded"
      ) {
        throw new EvaluationGateError(outcome);
      }
      if (outcome.decision.action === "accepted") {
        await ingestSessionMemories(session, prompt, finalOutput, options, atomicFlow, onEvent);
      }
    }

    onEvent({
      durationMs: Date.now() - startedAtMs,
      finishedAt: new Date().toISOString(),
      output: finalOutput,
      sessionId: session.context.sessionId,
      type: "session_finished",
    });

    return finalOutput;
  } catch (error) {
    if (error instanceof AgentStageStopError) {
      throw error;
    }
    if (options.signal?.aborted) {
      onEvent({
        durationMs: Date.now() - startedAtMs,
        finishedAt: new Date().toISOString(),
        reason: abortReason(options.signal),
        sessionId: session.context.sessionId,
        type: "session_cancelled",
      });
    } else {
      onEvent({
        durationMs: Date.now() - startedAtMs,
        error: getErrorMessage(error),
        finishedAt: new Date().toISOString(),
        sessionId: session.context.sessionId,
        ...(getErrorSource(error) !== undefined ? { source: getErrorSource(error) } : {}),
        ...(getErrorStack(error) !== undefined ? { stack: getErrorStack(error) } : {}),
        type: "session_failed",
      });
    }

    throw error;
  } finally {
    options.signal?.removeEventListener("abort", closeGraph);
    try {
      await industrialEvaluation?.close();
      closeGraph();
      if (ownsAtomicFlow) {
        await atomicFlow.close();
      }
    } finally {
      await eventDispatcher.flush();
    }
  }
}

function resolveEvaluationRunId(
  atomicRunId: string,
  existingEvents: ReturnType<AtomicFlowRun["snapshot"]>["events"],
): string {
  const completedInputs = new Set(
    existingEvents
      .filter((event) => event.atom.key === RUNTIME_ATOMS.inputPrompt.key)
      .map((event) => event.instance.id),
  ).size;
  if (completedInputs === 0) {
    return atomicRunId;
  }
  const candidate = `${atomicRunId}.eval-${completedInputs + 1}`;
  return candidate.length <= 128 ? candidate : `eval-${sha256Text(candidate)}`;
}

function resolveAgentSession(prompt: string, options: AgentSessionOptions): ResolvedSession {
  const workspaceDir = resolveWorkspaceDir(options);
  const paths = new YikuPaths({
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    workspaceDir,
  });
  const projectSources = extractProjectPromptInstructions({
    config: loadModelsConfig({ configPath: join(workspaceDir, "config.yaml") }),
    configPath: join(workspaceDir, "config.yaml"),
    env: loadEnvFile({ cwd: workspaceDir }),
    envPath: join(workspaceDir, ".env"),
  });
  const mergedEnv = mergeEnv(
    process.env,
    projectSources.env,
    loadEnvFile({ filePath: paths.envFilePath }),
    options.env ?? {},
  );
  const modelsConfig =
    options.modelsConfig ??
    mergeConfig(loadModelsConfig({ configPath: paths.configFilePath }), projectSources.config);
  const graph = resolveAgentGraph(modelsConfig);
  const selectedAgentKey =
    options.agentKey?.trim() || mergedEnv.YIKU_AGENT?.trim() || graph.defaultAgentKey || "code";
  const selectedDefinition = graph.items.get(selectedAgentKey);
  const modelKey = options.modelKey ?? selectedDefinition?.modelKey;
  const resolvedModel = resolveModelConfig({
    env: mergedEnv,
    ...(modelKey ? { modelKey } : {}),
    modelsConfig,
  });
  const instructions =
    selectedDefinition?.instructions?.trim() || resolvedModel.instructions?.trim();
  const promptGuard = options.promptGuard ?? new PromptGuard();
  const configuredPromptSegments = promptGuard.validateSegments([
    ...(options.modelsConfig === undefined ? projectSources.segments : []),
    ...(options.promptSegments ?? []),
  ]);
  const segmentInstructions = configuredPromptSegments
    .filter((segment) => segment.kind === "instruction" && segment.trust === "trusted")
    .map((segment) => segment.content)
    .join("\n\n");
  const additionalInstructions = [options.additionalInstructions?.trim(), segmentInstructions]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const sessionId = resolveSessionId(options);
  const sessionsDir =
    options.sessionsDir === undefined
      ? (options.runtimeStorage?.sessionsDir ?? paths.sessionsDir)
      : resolve(workspaceDir, options.sessionsDir);
  const traceFilePath = join(sessionsDir, `${sessionId}.jsonl`);
  const storage: RuntimeStoragePaths = {
    atomicRunsDir: options.runtimeStorage?.atomicRunsDir ?? paths.atomicRunsDir,
    evalsDir: options.runtimeStorage?.evalsDir ?? paths.evalsDir,
    memoryFilePath: options.runtimeStorage?.memoryFilePath ?? paths.workspaceMemoryFilePath,
    runsDir: options.runtimeStorage?.runsDir ?? paths.runsDir,
    sessionsDir,
  };

  return {
    apiKey: resolvedModel.apiKey,
    ...(resolvedModel.baseURL ? { baseURL: resolvedModel.baseURL } : {}),
    context: {
      agentKey: selectedAgentKey,
      agentName: options.agentName?.trim() || selectedDefinition?.name || resolvedModel.agentName,
      agentType: options.agentType?.trim() || selectedDefinition?.type || "code",
      apiKeyEnv: resolvedModel.apiKeyEnv,
      ...(resolvedModel.baseURL ? { baseURL: resolvedModel.baseURL } : {}),
      ...(resolvedModel.contextWindow !== undefined
        ? { contextWindow: resolvedModel.contextWindow }
        : {}),
      ...(resolvedModel.contextWindowSource !== undefined
        ? { contextWindowSource: resolvedModel.contextWindowSource }
        : {}),
      hasInstructions: Boolean(instructions || additionalInstructions),
      model: resolvedModel.model,
      modelKey: resolvedModel.modelKey,
      prompt,
      sessionId,
      sessionsDir,
      traceFilePath,
      transcriptFilePath: join(sessionsDir, `${sessionId}.transcript.jsonl`),
      workspaceDir,
    },
    env: mergedEnv,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    ...(instructions ? { instructions } : {}),
    modelsConfig,
    promptSegments: Object.freeze(
      configuredPromptSegments.filter(
        (segment) => segment.kind !== "instruction" || segment.trust !== "trusted",
      ),
    ),
    storage,
  };
}

async function buildSessionAgentGraph(
  session: ResolvedSession,
  options: AgentSessionOptions,
  atomicFlow: AtomicFlowRun,
  onEvent: (event: AgentProgressEvent) => void,
  onLegacyEvent: (event: AgentProgressEvent) => void,
  messageCorrelation: AgentMessageCorrelation,
): Promise<BuiltAgentGraph> {
  validateActivatedSkills(options, session.context.agentType);
  const batch = new ToolBatchTracker();
  const hookSession = options.hooks?.hookSession;
  const hookContext =
    hookSession === undefined
      ? undefined
      : {
          cwd: session.context.workspaceDir,
          hookSession,
          permissionMode: options.hooks?.permissionMode ?? "default",
          sessionId: session.context.sessionId,
          transcriptPath: session.context.transcriptFilePath,
        };
  const hookMiddleware =
    hookContext === undefined ? undefined : new ToolHookMiddleware(hookContext, batch);
  const middleware =
    options.toolCheckpointStore === undefined
      ? hookMiddleware
      : new SessionToolMiddleware({
          ...(options.workspaceCheckpointApproval !== undefined
            ? { checkpointApproval: options.workspaceCheckpointApproval }
            : {}),
          ...(options.workspaceCheckpointService !== undefined
            ? { checkpointService: options.workspaceCheckpointService }
            : {}),
          ...(hookMiddleware !== undefined ? { inner: hookMiddleware } : {}),
          sessionId: session.context.sessionId,
          shouldCheckpoint:
            options.workspaceCheckpointShouldCheckpoint ?? shouldCheckpointBashWorkspaceMutation,
          stageId: options.stageId ?? (() => "stage-0"),
          store: options.toolCheckpointStore,
        });
  const cwdTracker =
    hookContext === undefined
      ? undefined
      : new CwdTracker({
          initialCwd: hookContext.cwd,
          onChange: async ({ newCwd, oldCwd }) => {
            const decision = await hookContext.hookSession.dispatch({
              cwd: oldCwd,
              hook_event_name: "CwdChanged",
              new_cwd: newCwd,
              old_cwd: oldCwd,
              permission_mode: hookContext.permissionMode,
              session_id: hookContext.sessionId,
              transcript_path: hookContext.transcriptPath,
            });
            return typeof decision.updatedValue === "string" ? decision.updatedValue : undefined;
          },
        });
  const permissionApprovalHandler =
    hookContext === undefined
      ? options.permissionApprovalHandler
      : new HookPermissionApproval({
          context: hookContext,
          ...(options.permissionApprovalHandler !== undefined
            ? { userApprovalHandler: options.permissionApprovalHandler }
            : {}),
        }).handle;
  const taskRegistry = new TaskRegistry({
    eventBase: {
      cwd: session.context.workspaceDir,
      hook_event_name: "TaskCreated",
      permission_mode: options.hooks?.permissionMode ?? "default",
      session_id: session.context.sessionId,
      transcript_path: session.context.transcriptFilePath,
    },
    ...(hookSession !== undefined ? { hookSession } : {}),
    ...(options.taskStore !== undefined ? { store: options.taskStore } : {}),
  });
  const writeLock = new WorkspaceWriteLock();
  const worktreeManager = new WorktreeManager({
    ...(hookSession !== undefined
      ? {
          hookContext: {
            permissionMode: options.hooks?.permissionMode ?? "default",
            sessionId: session.context.sessionId,
            transcriptPath: session.context.transcriptFilePath,
          },
          hookSession,
        }
      : {}),
    ...(options.worktreeStorageDir !== undefined ? { storageDir: options.worktreeStorageDir } : {}),
    workspaceDir: session.context.workspaceDir,
  });
  const workspaceAccessController =
    options.workspaceAccessController ??
    new WorkspaceAccessController({
      accessMode: options.accessMode ?? "read-write",
    });
  workspaceAccessController.setApprovalHandler(options.workspaceAccessApprovalHandler);
  const workspace = new WorkspaceContext({
    accessController: workspaceAccessController,
    ...(options.additionalFileSystemRoots !== undefined
      ? { additionalRootDirs: options.additionalFileSystemRoots }
      : {}),
    environment: {
      ...process.env,
      ...session.env,
    },
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    rootDir: session.context.workspaceDir,
  });
  const promptSegments = new Map<string, PromptSegment>();
  const skillTools = await resolveMcpSkillTools(
    options,
    middleware,
    permissionApprovalHandler,
    workspace.workspaceId,
  );
  const agentProfiles = await options.agentManagementService?.list();
  const builtInSkills = {
    ...(options.agentManagementService !== undefined
      ? {
          agents: createAgentManagementSkill({
            ...(middleware !== undefined ? { middleware } : {}),
            profiles: agentProfiles ?? [],
            ...(options.userQuestionHandler !== undefined
              ? {
                  confirmRemove: async (profile) => {
                    const response = await options.userQuestionHandler?.({
                      options: ["Remove Profile", "Cancel"],
                      question: `Remove Subagent Profile ${profile.name}?`,
                    });
                    return responseAnswer(response) === "Remove Profile";
                  },
                  questionHandler: options.userQuestionHandler,
                }
              : {}),
            service: options.agentManagementService,
          }),
        }
      : {}),
    ...(options.skillRuntime !== undefined
      ? {
          skills: createSkillRuntimeSkill({
            agentType: session.context.agentType,
            ...(middleware !== undefined ? { middleware } : {}),
            onEvent,
            runtime: options.skillRuntime,
            worker: new SkillWorker({
              maxParallelWorkers: options.maxParallelReaders,
              onEvent,
              run: ({ prompt, signal, snapshot }) =>
                runAgentSessionTurn(prompt, {
                  ...options,
                  accessMode: "read-only",
                  activatedSkills: [snapshot.name],
                  continuationState: undefined,
                  workspaceAccessController: new WorkspaceAccessController({
                    accessMode: "read-only",
                  }),
                  ...(signal !== undefined ? { signal } : {}),
                }),
            }),
          }),
        }
      : {}),
  };
  const scope = new CapabilityScope({
    ...(options.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(Object.keys(builtInSkills).length > 0 ? { builtInSkills } : {}),
    ...(middleware !== undefined ? { middleware } : {}),
    onBoundaryChanged: (change) => {
      recordRuntimeAtomicEvent(atomicFlow, {
        ...change,
        type: "runtime_boundary_changed",
      });
      onEvent({
        ...change,
        type: "runtime_boundary_changed",
      });
    },
    ...(cwdTracker !== undefined
      ? {
          onCwdChanged: (cwd: string) => cwdTracker.update(cwd).then(() => undefined),
        }
      : {}),
    ...(permissionApprovalHandler !== undefined ? { permissionApprovalHandler } : {}),
    ...(options.permissionAssessmentHandler !== undefined
      ? { permissionAssessmentHandler: options.permissionAssessmentHandler }
      : {}),
    ...(options.skillRegistry !== undefined ? { registry: options.skillRegistry } : {}),
    ...(options.shellSandbox !== undefined ? { shellSandbox: options.shellSandbox } : {}),
    ...(skillTools !== undefined ? { skillTools } : {}),
    ...(options.todoExecutor !== undefined ? { todoExecutor: options.todoExecutor } : {}),
    ...(options.userQuestionHandler !== undefined
      ? { userQuestionHandler: options.userQuestionHandler }
      : {}),
    workspace,
  });
  let agent: Agent;
  try {
    agent = buildCodeAgentGraph({
      ...(options.activatedSkills !== undefined
        ? { activatedSkills: options.activatedSkills }
        : {}),
      ...(session.additionalInstructions !== undefined
        ? { additionalInstructions: session.additionalInstructions }
        : {}),
      agentKey: session.context.agentKey,
      agentName: session.context.agentName,
      ...(options.agentType !== undefined ? { agentType: options.agentType } : {}),
      env: session.env,
      ...(options.agentFactoryRegistry !== undefined
        ? { factoryRegistry: options.agentFactoryRegistry }
        : {}),
      ...(session.instructions !== undefined ? { instructions: session.instructions } : {}),
      modelKey: session.context.modelKey,
      modelsConfig: session.modelsConfig,
      onPromptSegments: (segments) => {
        for (const segment of segments) {
          const key = [
            segment.kind,
            segment.source,
            segment.sourceId ?? "",
            segment.digest ?? "",
            segment.content,
          ].join("\0");
          promptSegments.set(key, segment);
        }
      },
      scope,
      delegateTools: (_agentKey, delegates) =>
        delegates.length === 0
          ? []
          : [
              delegateTaskTool({
                allowedAgentKeys: delegates,
                eventBase: {
                  cwd: session.context.workspaceDir,
                  hook_event_name: "SubagentStart",
                  permission_mode: options.hooks?.permissionMode ?? "default",
                  session_id: session.context.sessionId,
                  transcript_path: session.context.transcriptFilePath,
                },
                ...(hookSession !== undefined ? { hookSession } : {}),
                maxParallelReaders: options.maxParallelReaders,
                ...(options.messageBus !== undefined ? { messageBus: options.messageBus } : {}),
                ...(middleware !== undefined ? { middleware } : {}),
                onEvent: (event) => {
                  if (options.atomicFlow !== undefined) {
                    recordRuntimeAtomicEvent(
                      options.atomicFlow,
                      event,
                      event.type === "subagent_spawned"
                        ? findRuntimeToolInstanceId(options.atomicFlow, event.parentToolCallId)
                        : undefined,
                    );
                  }
                  onLegacyEvent(event);
                },
                parentAgentId: messageCorrelation.agentId,
                resolveAgent: (agentKey) => {
                  const definition = resolveAgentGraph(session.modelsConfig).items.get(agentKey);
                  return {
                    agentName: definition?.name ?? agentKey,
                    agentType: definition?.type ?? "code",
                  };
                },
                run: async (input) => ({
                  changedFiles: [],
                  output: await runAgentSessionTurn(input.prompt, {
                    ...options,
                    accessMode: input.accessMode,
                    agentKey: input.agentKey,
                    ...(options.atomicFlow !== undefined
                      ? {
                          atomicParentInstanceId: getSubagentExecutionInstanceId(
                            options.atomicFlow,
                            input.agentId,
                          ),
                        }
                      : {}),
                    continuationState: undefined,
                    cwd: input.workspaceDir,
                    ...(options.messageBus !== undefined ? { messageBus: options.messageBus } : {}),
                    messageCorrelation: {
                      agentId: input.agentId,
                      agentSessionId: `${session.context.sessionId}.agent.${input.agentId}`,
                      parentAgentId: messageCorrelation.agentId,
                      ...(input.parentToolCallId !== undefined
                        ? { parentToolCallId: input.parentToolCallId }
                        : {}),
                      sessionId: session.context.sessionId,
                      taskId: input.taskId,
                    },
                    onContext: undefined,
                    onEvent: undefined,
                    workspaceAccessController: new WorkspaceAccessController({
                      accessMode: input.accessMode,
                      approvalHandler: options.workspaceAccessApprovalHandler,
                    }),
                    ...(input.signal !== undefined ? { signal: input.signal } : {}),
                  }),
                }),
                taskRegistry,
                worktreeManager,
                writeLock,
              }),
            ],
      workspaceDir: session.context.workspaceDir,
    });
  } catch (error) {
    scope.close();
    throw error;
  }

  return {
    agent,
    close: () => scope.close(),
    contextComposition: estimateContextComposition(agent, session, options, scope),
    flushToolBatch: async () => {
      if (hookContext === undefined) {
        return;
      }

      await batch.flush({
        eventBase: {
          cwd: hookContext.cwd,
          hook_event_name: "PostToolBatch",
          permission_mode: hookContext.permissionMode,
          session_id: hookContext.sessionId,
          transcript_path: hookContext.transcriptPath,
        },
        hookSession: hookContext.hookSession,
      });
    },
    promptSegments: Object.freeze([...promptSegments.values()]),
  };
}

function validateActivatedSkills(options: AgentSessionOptions, agentType: string): void {
  if (options.skillRuntime === undefined || options.activatedSkills === undefined) {
    return;
  }
  const discovered = options.activatedSkills.filter(
    (name) => options.skillRuntime?.inspect(name) !== undefined,
  );
  if (discovered.length > 0) {
    options.skillRuntime.snapshot(discovered, agentType);
  }
}

function shouldCheckpointBashWorkspaceMutation(request: SessionToolCheckpointRequest): boolean {
  if (
    request.effect !== "process" ||
    request.toolName !== "bashTool" ||
    typeof request.input !== "object" ||
    request.input === null ||
    !("command" in request.input) ||
    typeof request.input.command !== "string"
  ) {
    return false;
  }

  return (
    assessBashCommandRisk(request.input.command)?.capabilities.some(
      (capability) => capability === "workspace.write" || capability === "workspace.delete",
    ) === true
  );
}

function estimateContextComposition(
  agent: Agent,
  session: ResolvedSession,
  options: AgentSessionOptions,
  scope: CapabilityScope,
): AgentContextComposition {
  const definition = resolveAgentGraph(session.modelsConfig).items.get(session.context.agentKey);
  const skillNames = [...(definition?.skills ?? []), ...(options.activatedSkills ?? [])];
  const skillInstructions = scope.resolveInstructions([...new Set(skillNames)]);
  const instructions = typeof agent.instructions === "string" ? agent.instructions : "";
  const memoryCharacters = session.memoryContext?.length ?? 0;
  const toolCharacters = JSON.stringify(
    agent.tools.map((tool) => ({
      description: "description" in tool ? tool.description : undefined,
      name: tool.name,
      parameters: "parameters" in tool ? tool.parameters : undefined,
    })),
  ).length;
  const classCharacters = session.memoryContextCharacters ?? {
    procedure: 0,
    scenario: 0,
    semantic: 0,
    working: 0,
  };

  return {
    procedureMemoryTokens: estimateTokens(classCharacters.procedure),
    scenarioMemoryTokens: estimateTokens(classCharacters.scenario),
    semanticMemoryTokens: estimateTokens(classCharacters.semantic),
    skillTokens: estimateTokens(skillInstructions.length),
    systemPromptTokens: estimateTokens(
      Math.max(0, instructions.length - skillInstructions.length - memoryCharacters),
    ),
    systemToolTokens: estimateTokens(toolCharacters),
    workingMemoryTokens: estimateTokens(classCharacters.working),
  };
}

function estimateTokens(characters: number): number {
  return Math.max(0, Math.ceil(characters / 4));
}

async function resolveMcpSkillTools(
  options: AgentSessionOptions,
  middleware: import("@yiku/agent-code").ToolExecutionMiddleware | undefined,
  permissionApprovalHandler: import("@yiku/agent-code").PermissionApprovalHandler | undefined,
  workspaceId: string,
): Promise<Readonly<Record<string, readonly import("@openai/agents").Tool[]>> | undefined> {
  const registry = options.mcpRegistry;
  const targetsBySkill = options.mcpSkillTargets;
  if (registry === undefined || targetsBySkill === undefined) {
    return undefined;
  }

  const entries = await Promise.all(
    Object.entries(targetsBySkill).map(async ([skill, targets]) => {
      const servers = Object.freeze([
        ...new Set(
          targets
            .map((target) => target.split("/", 1)[0])
            .filter((server): server is string => server !== undefined && server.length > 0),
        ),
      ]);
      const tools = await mcpTools({
        ...(middleware !== undefined ? { middleware } : {}),
        ...(permissionApprovalHandler !== undefined ? { permissionApprovalHandler } : {}),
        registry,
        servers,
        targets,
        workspaceId,
      });
      return [skill, tools] as const;
    }),
  );

  return Object.freeze(Object.fromEntries(entries));
}

async function attachRecalledMemories(
  session: ResolvedSession,
  prompt: string,
  options: AgentSessionOptions,
  atomicFlow: AtomicFlowRun,
  parentInstanceId: string,
  onEvent: (event: AgentProgressEvent) => void,
): Promise<ResolvedSession> {
  const memories = options.memories;

  if (memories === undefined) {
    return session;
  }

  const progress = startMemoryProgress(onEvent, "recall", memories.context.namespace);
  try {
    const maxChars = memories.recall?.maxChars ?? DEFAULT_MEMORY_POLICY.defaultRecallMaxChars;
    let memoryContext: string;
    let memoryContextCharacters:
      | Readonly<Record<"procedure" | "scenario" | "semantic" | "working", number>>
      | undefined;
    let recalledCount: number;
    let recalledClassAtom:
      | (typeof MEMORY_CLASS_ATOMS)[keyof typeof MEMORY_CLASS_ATOMS]
      | typeof MEMORY_ATOMS.working
      | undefined;

    if (memories.lifecycle !== undefined) {
      const recalled = await memories.lifecycle.recall({
        atomicFlow,
        atomicParentInstanceId: parentInstanceId,
        classes:
          memories.recall?.kinds === undefined
            ? undefined
            : [
                "working",
                ...new Set(memories.recall.kinds.map((kind) => memoryClassForKind(kind))),
              ],
        context: memories.context,
        ...(memories.recall?.limit !== undefined ? { limit: memories.recall.limit } : {}),
        maxChars,
        query: prompt,
        sessionId: session.context.sessionId,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const rendered = renderMemorySearchContext(recalled, { maxChars });
      memoryContext = rendered.content;
      memoryContextCharacters = rendered.charactersByClass;
      recalledCount = recalled.length;
      const lastClass = recalled.at(-1)?.class;
      recalledClassAtom =
        lastClass === undefined
          ? undefined
          : lastClass === "working"
            ? MEMORY_ATOMS.working
            : MEMORY_CLASS_ATOMS[lastClass];
    } else {
      const recalled = await memories.manager.recall({
        atomicFlow,
        atomicParentInstanceId: parentInstanceId,
        context: memories.context,
        ...(memories.recall?.kinds !== undefined ? { kinds: memories.recall.kinds } : {}),
        ...(memories.recall?.limit !== undefined ? { limit: memories.recall.limit } : {}),
        maxChars,
        query: prompt,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      memoryContext = renderMemoryContext(recalled, { maxChars });
      recalledCount = recalled.length;
      recalledClassAtom =
        recalled.length === 0
          ? undefined
          : MEMORY_CLASS_ATOMS[memoryClassForKind(recalled.at(-1)?.memory.kind ?? "fact")];
    }

    if (!memoryContext) {
      progress.end({
        counts: {
          selected: recalledCount,
        },
      });
      return session;
    }

    const recallInstanceId = atomicFlow
      .snapshot()
      .events.findLast((event) => event.atom.key === MEMORY_ATOMS.recall.key)?.instance.id;
    const recalledClassEvent =
      recalledClassAtom === undefined
        ? undefined
        : atomicFlow
            .snapshot()
            .events.findLast(
              (event) => event.atom.key === recalledClassAtom.key && event.phase === "end",
            );
    const contextSpan = atomicFlow.start({
      atom: MEMORY_ATOMS.contextInject,
      edge: {
        fromAtomKey: recalledClassEvent?.atom.key ?? MEMORY_ATOMS.recall.key,
        kind: "data",
        toAtomKey: MEMORY_ATOMS.contextInject.key,
      },
      parentInstanceId: recalledClassEvent?.instance.id ?? recallInstanceId ?? parentInstanceId,
      payload: {
        counts: {
          characters: memoryContext.length,
          memories: recalledCount,
        },
      },
    });
    contextSpan.end();
    progress.end({
      counts: {
        characters: memoryContext.length,
        selected: recalledCount,
      },
    });

    return {
      ...session,
      memoryContext,
      ...(memoryContextCharacters !== undefined ? { memoryContextCharacters } : {}),
      promptSegments: Object.freeze([
        ...session.promptSegments,
        {
          content: memoryContext,
          kind: "reference",
          source: "memory",
          sourceId: "session-recall",
          trust: "untrusted",
        },
      ]),
    };
  } catch (error) {
    progress.error(error);
    handleMemoryFailure(error, memories, "recall");
    return session;
  }
}

async function captureWorkingPrompt(
  prompt: string,
  sessionId: string,
  options: AgentSessionOptions,
  atomicFlow: AtomicFlowRun,
  parentInstanceId: string,
  onEvent: (event: AgentProgressEvent) => void,
): Promise<void> {
  const memories = options.memories;
  if (memories?.lifecycle === undefined) {
    return;
  }

  const progress = startMemoryProgress(onEvent, "capture", memories.context.namespace);
  try {
    await memories.lifecycle.captureWorking({
      atomicFlow,
      atomicParentInstanceId: parentInstanceId,
      content: prompt,
      sessionId,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      source: "prompt",
    });
    progress.end({ counts: { captured: 1 } });
  } catch (error) {
    progress.error(error);
    handleMemoryFailure(error, memories, "capture");
  }
}

async function ingestSessionMemories(
  session: ResolvedSession,
  prompt: string,
  output: string,
  options: AgentSessionOptions,
  atomicFlow: AtomicFlowRun,
  onEvent: (event: AgentProgressEvent) => void,
): Promise<void> {
  const memories = options.memories;

  if (memories?.extraction?.enabled !== true) {
    return;
  }

  const scope = memories.context.scope;
  const replyInstanceId = atomicFlow
    .snapshot()
    .events.findLast((event) => event.atom.key === RUNTIME_ATOMS.replyFinal.key)?.instance.id;

  const progress = startMemoryProgress(
    onEvent,
    memories.lifecycle === undefined ? "ingest" : "consolidate",
    memories.context.namespace,
  );
  try {
    if (memories.lifecycle !== undefined) {
      await memories.lifecycle.extractToWorking({
        agentId: scope?.agentId ?? session.context.agentKey,
        atomicFlow,
        ...(replyInstanceId !== undefined ? { atomicParentInstanceId: replyInstanceId } : {}),
        context: memories.context,
        output,
        ...(scope?.projectId !== undefined ? { projectId: scope.projectId } : {}),
        prompt,
        sessionId: session.context.sessionId,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(scope?.userId !== undefined ? { userId: scope.userId } : {}),
      });
      const workingInstanceId = atomicFlow
        .snapshot()
        .events.findLast((event) => event.atom.key === MEMORY_ATOMS.working.key)?.instance.id;
      const consolidated = await memories.lifecycle.consolidate({
        atomicFlow,
        ...(workingInstanceId !== undefined ? { atomicParentInstanceId: workingInstanceId } : {}),
        context: memories.context,
        sessionId: session.context.sessionId,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (consolidated.failed > 0 && memories.failureMode === "strict") {
        throw new MemoryStoreError(
          "MEMORY_STORE_UNAVAILABLE",
          `Memory consolidation failed for ${consolidated.failed} candidate(s).`,
          { operation: "consolidate" },
        );
      }
      progress.end({
        counts: {
          consolidated: consolidated.consolidated,
          discarded: consolidated.discarded,
          failed: consolidated.failed,
          pending: consolidated.pending,
        },
      });
      return;
    }

    const ingested = await memories.manager.ingestSession({
      agentId: scope?.agentId ?? session.context.agentKey,
      atomicFlow,
      ...(replyInstanceId !== undefined ? { atomicParentInstanceId: replyInstanceId } : {}),
      context: memories.context,
      output,
      ...(scope?.projectId !== undefined ? { projectId: scope.projectId } : {}),
      prompt,
      sessionId: session.context.sessionId,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(scope?.userId !== undefined ? { userId: scope.userId } : {}),
    });
    progress.end(
      ingested === undefined
        ? {}
        : {
            counts: {
              discarded: ingested.discarded,
              extracted: ingested.extracted,
              written: ingested.memories.length,
            },
          },
    );
  } catch (error) {
    progress.error(error);
    handleMemoryFailure(error, memories, "ingest");
  }
}

async function createIndustrialEvaluationRuntime(
  session: ResolvedSession,
  options: AgentSessionOptions,
  graph: BuiltAgentGraph,
): Promise<IndustrialEvaluationRuntime | undefined> {
  const evals = options.evals;
  if (evals?.enabled === false || evals?.profile === undefined) {
    return undefined;
  }
  const workspace = new WorkspaceContext({
    ...(options.workspaceAccessController !== undefined
      ? { accessController: options.workspaceAccessController }
      : { accessMode: options.accessMode ?? "read-write" }),
    environment: {
      ...process.env,
      ...session.env,
    },
    rootDir: session.context.workspaceDir,
  });
  const provider = getAgentRuntimeMetadata(graph.agent)?.evaluationProvider;
  let commandRunner: VerificationCommandRunner | undefined;
  let codeCollector: CodeArtifactCollector | undefined;
  let codeInitialSnapshot: Awaited<ReturnType<CodeArtifactCollector["capture"]>> | undefined;
  let isolatedWorkspaceDir: string | undefined;
  let evaluators = evals.evaluators;

  if (evaluators === undefined && provider !== undefined) {
    evaluators = provider.createEvaluators(evals.providerConfig);
  } else if (evaluators === undefined && session.context.agentType === "code") {
    const needsIsolation = evals.profile.checks.some(
      (check) =>
        check.evaluator === "code-verification-command" &&
        verificationWritePolicy(check.config.command) === "isolated",
    );
    const commandWorkspace = needsIsolation
      ? await createIsolatedEvaluationWorkspace(workspace)
      : workspace;
    isolatedWorkspaceDir = needsIsolation ? commandWorkspace.rootDir : undefined;
    commandRunner = new VerificationCommandRunner({
      ...(options.shellSandbox !== undefined ? { sandbox: options.shellSandbox } : {}),
      isolatedWorkspace: needsIsolation,
      ...(needsIsolation ? { runtimeReadPaths: [join(workspace.rootDir, "node_modules")] } : {}),
      workspace: commandWorkspace,
    });
    evaluators = createCodeEvaluators(commandRunner);
  } else {
    evaluators ??= DEFAULT_CHECK_EVALUATORS;
  }
  if (session.context.agentType === "code") {
    codeCollector = new CodeArtifactCollector({
      workspace,
    });
    codeInitialSnapshot = await codeCollector.capture();
  }
  const registry = new EvaluatorRegistry(evaluators);
  const coordinator = new EvaluationCoordinator({
    planner: new EvalPlanner({ registry }),
    profile: evals.profile,
    scheduler: new EvalScheduler({
      ...(evals.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: evals.maxConcurrentRuns }
        : {}),
      registry,
    }),
    store:
      evals.store ??
      new FileEvalResultStore({
        rootDir: session.storage.evalsDir,
      }),
  });
  return {
    ...(codeCollector !== undefined ? { codeCollector } : {}),
    ...(codeInitialSnapshot !== undefined ? { codeInitialSnapshot } : {}),
    ...(commandRunner !== undefined ? { commandRunner } : {}),
    coordinator,
    async close() {
      commandRunner?.close();
      if (isolatedWorkspaceDir !== undefined) {
        await rm(isolatedWorkspaceDir, { force: true, recursive: true });
      }
    },
    async snapshot(output) {
      if (provider !== undefined) {
        return provider.snapshot(output);
      }
      if (codeCollector !== undefined && codeInitialSnapshot !== undefined) {
        const current = await codeCollector.capture();
        const artifacts = codeCollector.compare(codeInitialSnapshot, current);
        if (isolatedWorkspaceDir !== undefined) {
          await syncEvaluationArtifacts(workspace.rootDir, isolatedWorkspaceDir, artifacts);
        }
        return {
          artifacts,
        };
      }
      return {
        artifacts: [],
      };
    },
  };
}

function verificationWritePolicy(value: unknown): "isolated" | "read-only" | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const policy = (value as Readonly<Record<string, unknown>>).writePolicy;
  return policy === "isolated" || policy === "read-only" ? policy : undefined;
}

async function createIsolatedEvaluationWorkspace(
  workspace: WorkspaceContext,
): Promise<WorkspaceContext> {
  const destination = await mkdtemp(join(tmpdir(), "yiku-eval-workspace-"));
  try {
    await cp(workspace.rootDir, destination, {
      filter: (source) => {
        const path = relative(workspace.rootDir, source);
        if (!path) {
          return true;
        }
        const segments = path.split(sep);
        return !segments.some((segment, index) =>
          index === 0
            ? [".git", ".yiku", "coverage", "dist", "node_modules"].includes(segment)
            : segment === "coverage" || segment === "dist",
        );
      },
      force: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    const sourceModules = join(workspace.rootDir, "node_modules");
    try {
      if ((await lstat(sourceModules)).isDirectory()) {
        await symlink(sourceModules, join(destination, "node_modules"), "dir");
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    return new WorkspaceContext({
      accessMode: "read-write",
      environment: workspace.environment,
      rootDir: destination,
    });
  } catch (error) {
    await rm(destination, { force: true, recursive: true });
    throw error;
  }
}

async function syncEvaluationArtifacts(
  sourceRoot: string,
  destinationRoot: string,
  artifacts: readonly AgentArtifactRef[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.kind !== "file-change" || artifact.metadata.externalSymlink === true) {
      continue;
    }
    const configuredPath = artifact.metadata.path;
    const changeType = artifact.metadata.changeType;
    if (typeof configuredPath !== "string" || typeof changeType !== "string") {
      continue;
    }
    const source = containedPath(sourceRoot, configuredPath);
    const destination = containedPath(destinationRoot, configuredPath);
    if (changeType === "deleted") {
      await rm(destination, { force: true, recursive: true });
      continue;
    }
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    const sourceStat = await lstat(source);
    await rm(destination, { force: true, recursive: true });
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else {
      await cp(source, destination, {
        force: true,
        recursive: false,
        verbatimSymlinks: true,
      });
    }
  }
}

function containedPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const boundary = relative(root, resolved);
  if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
    throw new Error("Evaluation artifact path escapes its workspace.");
  }
  return resolved;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sessionRuntimeMetrics(
  startedAtMs: number,
  startedRssBytes: number,
): NonNullable<EvaluationRepairResult["runtimeMetrics"]> {
  return {
    durationMs: Math.max(0, Date.now() - startedAtMs),
    peakRssBytes: Math.max(0, process.memoryUsage().rss - startedRssBytes),
  };
}

async function evaluateSession(
  output: string,
  options: AgentSessionOptions,
  atomicFlow: AtomicFlowRun,
): Promise<void> {
  if (options.evals?.enabled === false) {
    return;
  }

  await atomicFlow.flush();
  const snapshot = atomicFlow.snapshot();
  const parentInstanceId = snapshot.events.findLast(
    (event) => event.atom.key === RUNTIME_ATOMS.replyFinal.key,
  )?.instance.id;
  const scorecard = await (options.evals?.runner ?? new EvalRunner()).run({
    atomicFlow,
    finalOutput: output,
    flow: snapshot,
    ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  try {
    options.evals?.onScorecard?.(scorecard);
  } catch {
    // Evaluation observers cannot change the completed Agent output.
  }
}

function handleMemoryFailure(
  error: unknown,
  options: AgentSessionMemoryOptions,
  operation: "capture" | "ingest" | "recall",
): void {
  const memoryError =
    error instanceof MemoryError
      ? error
      : new MemoryStoreError(
          "MEMORY_STORE_UNAVAILABLE",
          `Agent session memory ${operation} failed.`,
          { cause: error, operation },
        );

  try {
    options.onError?.(memoryError);
  } catch {
    // A reporting callback must not change configured memory failure behavior.
  }

  if (options.failureMode === "strict") {
    throw memoryError;
  }
}

function resolveWorkspaceDir(options: AgentSessionOptions): string {
  return resolve(
    options.cwd ??
      options.env?.YIKU_WORKSPACE_DIR ??
      process.env.YIKU_WORKSPACE_DIR ??
      process.cwd(),
  );
}

function resolveSessionId(options: AgentSessionOptions): string {
  const configuredSessionId = options.sessionId?.trim();

  return configuredSessionId ? sanitizeSessionId(configuredSessionId) : randomUUID();
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function createTraceEventHandler(
  trace: Trace<AgentProgressEvent>,
  options: {
    readonly correlation: AgentMessageCorrelation;
    readonly messageBus?: AgentSessionOptions["messageBus"];
    readonly onEvent?: ((event: AgentProgressEvent) => void) | undefined;
  },
): {
  readonly emit: (event: AgentProgressEvent) => void;
  readonly emitLegacy: (event: AgentProgressEvent) => void;
  readonly flush: () => Promise<void>;
} {
  const pending = new Set<Promise<void>>();
  let publicationError: unknown;
  const emitLegacy = (event: AgentProgressEvent) => {
    trace.record(event);
    options.onEvent?.(event);
  };

  return {
    emit: (event) => {
      if (options.messageBus === undefined) {
        emitLegacy(event);
        return;
      }

      trace.record(event);
      const envelope = progressEventToEnvelope(event, options.correlation);
      const publication = options.messageBus.publish(envelope);
      pending.add(publication);
      void publication.then(
        () => pending.delete(publication),
        (error: unknown) => {
          publicationError ??= error;
          pending.delete(publication);
        },
      );
      options.onEvent?.(envelopeToProgressEvent(envelope) ?? event);
    },
    emitLegacy,
    flush: async () => {
      await Promise.allSettled([...pending]);
      if (publicationError !== undefined) {
        throw publicationError;
      }
    },
  };
}

function resolveMessageCorrelation(
  configured: AgentMessageCorrelation | undefined,
  context: AgentSessionContext,
): AgentMessageCorrelation {
  return configured === undefined
    ? {
        agentId: context.agentKey,
        sessionId: context.sessionId,
      }
    : {
        ...configured,
        sessionId: context.sessionId,
      };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal | undefined): string {
  if (signal === undefined || !signal.aborted) {
    return "Agent session was cancelled.";
  }
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Agent session was cancelled.";
}

function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function getErrorSource(error: unknown): string | undefined {
  return getErrorStack(error)
    ?.split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith("at ") &&
        !line.includes("node_modules") &&
        (line.includes("/packages/") || line.includes("/playground/")),
    );
}

function emitSessionFailure(
  onEvent: (event: AgentProgressEvent) => void,
  sessionId: string,
  startedAtMs: number,
  error: unknown,
): void {
  onEvent({
    durationMs: Date.now() - startedAtMs,
    error: getErrorMessage(error),
    finishedAt: new Date().toISOString(),
    sessionId,
    ...(getErrorSource(error) !== undefined ? { source: getErrorSource(error) } : {}),
    ...(getErrorStack(error) !== undefined ? { stack: getErrorStack(error) } : {}),
    type: "session_failed",
  });
}

function responseAnswer(response: UserQuestionResponse | undefined): string | undefined {
  return response === undefined
    ? undefined
    : "answer" in response
      ? response.answer
      : response.answers[0]?.answers[0];
}
