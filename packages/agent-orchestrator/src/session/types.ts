import type {
  CodeToolAccessMode,
  PermissionApprovalHandler,
  PermissionAssessmentHandler,
  TodoToolExecutor,
  UserQuestionHandler,
  WorkspaceAccessController,
  WorkspaceWriteAccessApprovalHandler,
} from "@yiku/agent-code";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import type { EnvVars, ModelsConfig } from "@yiku/config";
import type {
  EvalCheckEvaluator,
  EvalProfile,
  EvalResultStore,
  EvalRunner,
  EvalScorecard,
} from "@yiku/evals";
import type { HookEngine, HookPermissionMode, HookSession } from "@yiku/hooks";
import type {
  MemoryContext,
  MemoryError,
  MemoryKind,
  MemoryLifecycle,
  MemoryManager,
} from "@yiku/memories";
import type { ShellProcessSandbox } from "@yiku/sandbox";
import type { Trace } from "@yiku/trajectory";
import type { AgentFactoryRegistry } from "../agents/agent-factory-registry.js";
import type { AgentManagementService } from "../agents/agent-management-service.js";
import type { ContextWindowSource } from "../config/types.js";
import type { EvaluationOutcome } from "../evals/evaluation-coordinator.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { AgentMessageBus } from "../messages/message-bus.js";
import type { AgentMessageCorrelation } from "../messages/progress-adapter.js";
import type { PromptGuard, PromptSegment } from "../prompt/index.js";
import type {
  SessionToolCheckpointApproval,
  SessionToolCheckpointStore,
  SessionToolShouldCheckpoint,
  SessionToolWorkspaceCheckpointService,
} from "../runtime/session-tool-middleware.js";
import type {
  AgentContinuationState,
  AgentProgressEvent,
  AgentProgressHandler,
} from "../runtime/types.js";
import type { SkillRuntime } from "../skills/skill-runtime.js";
import type { SkillRegistry } from "../skills/types.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { WorkspaceConfigChange, WorkspaceConfigFile } from "../workspace/config-watcher.js";
import type { ContextSummarizer } from "./compactor.js";
import type { RuntimeStoragePaths } from "./runtime-storage.js";

export interface AgentSessionContext {
  readonly agentKey: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly apiKeyEnv: string;
  readonly compactAtContextRatio?: number | undefined;
  readonly contextComposition?: AgentContextComposition | undefined;
  readonly baseURL?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly hasInstructions: boolean;
  readonly model: string;
  readonly modelKey: string;
  readonly prompt: string;
  readonly sessionId: string;
  readonly sessionsDir: string;
  readonly traceFilePath: string;
  readonly transcriptFilePath: string;
  readonly workspaceDir: string;
}

export interface AgentContextComposition {
  readonly procedureMemoryTokens: number;
  readonly scenarioMemoryTokens: number;
  readonly semanticMemoryTokens: number;
  readonly skillTokens: number;
  readonly systemPromptTokens: number;
  readonly systemToolTokens: number;
  readonly workingMemoryTokens: number;
}

export type AgentSessionStartSource = "clear" | "compact" | "resume" | "startup";
export type AgentSessionEndReason =
  | "bypass_permissions_disabled"
  | "clear"
  | "logout"
  | "other"
  | "prompt_input_exit"
  | "resume";

export interface AgentSessionHookOptions {
  readonly applyConfig?: ((change: WorkspaceConfigChange) => Promise<void> | void) | undefined;
  readonly configFiles?: readonly WorkspaceConfigFile[] | undefined;
  readonly compactionMaxChars?: number | undefined;
  readonly engine: HookEngine;
  readonly instructionFiles?: readonly string[] | undefined;
  readonly hookSession?: HookSession | undefined;
  readonly onWatcherError?: ((error: Error) => void) | undefined;
  readonly permissionMode?: HookPermissionMode | undefined;
  readonly summarizer?: ContextSummarizer | undefined;
  readonly watchedFiles?: readonly string[] | undefined;
}

export interface AgentSessionMemoryOptions {
  readonly context: MemoryContext;
  readonly extraction?:
    | {
        readonly enabled: boolean;
      }
    | undefined;
  readonly failureMode?: "best-effort" | "strict" | undefined;
  readonly lifecycle?: MemoryLifecycle | undefined;
  readonly manager: MemoryManager;
  readonly onError?: ((error: MemoryError) => void) | undefined;
  readonly recall?:
    | {
        readonly kinds?: readonly MemoryKind[] | undefined;
        readonly limit?: number | undefined;
        readonly maxChars?: number | undefined;
      }
    | undefined;
}

export interface AgentSessionEvalOptions {
  readonly enabled?: boolean | undefined;
  readonly evaluators?: readonly EvalCheckEvaluator[] | undefined;
  readonly maxConcurrentRuns?: number | undefined;
  readonly onOutcome?: ((outcome: EvaluationOutcome) => void) | undefined;
  readonly onScorecard?: ((scorecard: EvalScorecard) => void) | undefined;
  readonly profile?: EvalProfile | undefined;
  readonly providerConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly repair?: boolean | undefined;
  readonly runner?: EvalRunner | undefined;
  readonly store?: EvalResultStore | undefined;
}

export interface AgentSessionOptions {
  readonly accessMode?: CodeToolAccessMode | undefined;
  readonly activatedSkills?: readonly string[] | undefined;
  readonly additionalFileSystemRoots?: readonly string[] | undefined;
  readonly additionalInstructions?: string | undefined;
  readonly agentFactoryRegistry?: AgentFactoryRegistry | undefined;
  readonly agentManagementService?: AgentManagementService | undefined;
  readonly agentKey?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentType?: string | undefined;
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly atomicParentInstanceId?: string | undefined;
  readonly contextSummarizer?: ContextSummarizer | undefined;
  readonly continuationState?: AgentContinuationState | undefined;
  readonly cwd?: string | undefined;
  readonly env?: EnvVars | undefined;
  readonly evals?: AgentSessionEvalOptions | undefined;
  readonly homeDir?: string | undefined;
  readonly hooks?: AgentSessionHookOptions | undefined;
  readonly memories?: AgentSessionMemoryOptions | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxParallelReaders?: number | undefined;
  readonly messageBus?: AgentMessageBus | undefined;
  readonly messageCorrelation?: AgentMessageCorrelation | undefined;
  readonly mcpRegistry?: McpRegistry | undefined;
  readonly mcpSkillTargets?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly modelKey?: string | undefined;
  readonly modelsConfig?: ModelsConfig | undefined;
  readonly onContext?: ((context: AgentSessionContext) => void) | undefined;
  readonly onEvent?: AgentProgressHandler | undefined;
  readonly permissionApprovalHandler?: PermissionApprovalHandler | undefined;
  readonly permissionAssessmentHandler?: PermissionAssessmentHandler | undefined;
  readonly promptGuard?: PromptGuard | undefined;
  readonly promptSegments?: readonly PromptSegment[] | undefined;
  readonly runImpl?: typeof import("../runtime/run.js").run | undefined;
  readonly shellSandbox?: ShellProcessSandbox | undefined;
  readonly runtimeStorage?: RuntimeStoragePaths | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionsDir?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly skillRegistry?: SkillRegistry | undefined;
  readonly skillRuntime?: SkillRuntime | undefined;
  readonly stageId?: (() => string) | undefined;
  readonly taskStore?: TaskStore | undefined;
  readonly trace?: Trace<AgentProgressEvent> | undefined;
  readonly toolCheckpointStore?: SessionToolCheckpointStore | undefined;
  readonly todoExecutor?: TodoToolExecutor | undefined;
  readonly userQuestionHandler?: UserQuestionHandler | undefined;
  readonly worktreeStorageDir?: string | undefined;
  readonly workspaceAccessApprovalHandler?: WorkspaceWriteAccessApprovalHandler | undefined;
  readonly workspaceAccessController?: WorkspaceAccessController | undefined;
  readonly workspaceCheckpointApproval?: SessionToolCheckpointApproval | undefined;
  readonly workspaceCheckpointService?: SessionToolWorkspaceCheckpointService | undefined;
  readonly workspaceCheckpointShouldCheckpoint?: SessionToolShouldCheckpoint | undefined;
}

export interface AgentSessionSubmitOptions {
  readonly activatedSkills?: AgentSessionOptions["activatedSkills"];
  readonly commandArgs?: string | undefined;
  readonly commandName?: string | undefined;
  readonly atomicFlow?: AgentSessionOptions["atomicFlow"];
  readonly continuationState?: AgentContinuationState | undefined;
  readonly maxTurns?: AgentSessionOptions["maxTurns"];
  readonly onContext?: AgentSessionOptions["onContext"];
  readonly onEvent?: AgentSessionOptions["onEvent"];
  readonly permissionApprovalHandler?: AgentSessionOptions["permissionApprovalHandler"];
  readonly permissionAssessmentHandler?: AgentSessionOptions["permissionAssessmentHandler"];
  readonly signal?: AgentSessionOptions["signal"];
  readonly userQuestionHandler?: AgentSessionOptions["userQuestionHandler"];
  readonly workspaceAccessApprovalHandler?: AgentSessionOptions["workspaceAccessApprovalHandler"];
}

export interface AgentSessionResult {
  readonly context: AgentSessionContext;
  readonly output: string;
}
