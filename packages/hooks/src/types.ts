export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "Setup",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "MessageDisplay",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "Elicitation",
  "ElicitationResult",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type HookExecutorType = "agent" | "callback" | "command" | "http" | "mcp" | "prompt";
export type HookSourceType =
  | "agent"
  | "local"
  | "managed"
  | "plugin"
  | "project"
  | "runtime"
  | "skill"
  | "user";
export type HookAction = "allow" | "block" | "defer" | "no-op" | "stop";
export type HookPermissionDecision = "allow" | "ask" | "deny";
export type HookExecutionStatus = "aborted" | "background" | "error" | "success" | "timeout";

export type HookPermissionMode =
  | "acceptEdits"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan"
  | (string & {});

export interface HookEventBase<TName extends HookEventName> {
  readonly cwd: string;
  readonly hook_event_name: TName;
  readonly permission_mode: HookPermissionMode;
  readonly session_id: string;
  readonly transcript_path: string;
}

export interface SessionStartHookEvent extends HookEventBase<"SessionStart"> {
  readonly agent_type?: string | undefined;
  readonly model?: string | undefined;
  readonly source: "clear" | "compact" | "resume" | "startup";
}

export interface SetupHookEvent extends HookEventBase<"Setup"> {
  readonly trigger: "init" | "maintenance";
}

export interface InstructionsLoadedHookEvent extends HookEventBase<"InstructionsLoaded"> {
  readonly file_path: string;
  readonly load_reason:
    | "compact"
    | "include"
    | "nested_traversal"
    | "path_glob_match"
    | "session_start";
  readonly memory_type?: string | undefined;
}

export interface UserPromptSubmitHookEvent extends HookEventBase<"UserPromptSubmit"> {
  readonly prompt: string;
}

export interface UserPromptExpansionHookEvent extends HookEventBase<"UserPromptExpansion"> {
  readonly command_args?: string | undefined;
  readonly command_name: string;
  readonly prompt: string;
}

export interface MessageDisplayHookEvent extends HookEventBase<"MessageDisplay"> {
  readonly message: string;
}

export interface ToolHookEventBase<
  TName extends
    | "PermissionDenied"
    | "PermissionRequest"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "PreToolUse",
> extends HookEventBase<TName> {
  readonly tool_input: JsonObject;
  readonly tool_name: string;
  readonly tool_use_id: string;
}

export interface PreToolUseHookEvent extends ToolHookEventBase<"PreToolUse"> {}

export interface PermissionRequestHookEvent extends ToolHookEventBase<"PermissionRequest"> {
  readonly permission_suggestions?: readonly JsonObject[] | undefined;
}

export interface PostToolUseHookEvent extends ToolHookEventBase<"PostToolUse"> {
  readonly tool_response: JsonValue;
}

export interface PostToolUseFailureHookEvent extends ToolHookEventBase<"PostToolUseFailure"> {
  readonly error: string;
  readonly is_interrupt?: boolean | undefined;
}

export interface PostToolBatchResult {
  readonly status: "failed" | "succeeded";
  readonly tool_name: string;
  readonly tool_use_id: string;
}

export interface PostToolBatchHookEvent extends HookEventBase<"PostToolBatch"> {
  readonly results: readonly PostToolBatchResult[];
}

export interface PermissionDeniedHookEvent extends ToolHookEventBase<"PermissionDenied"> {
  readonly denial_reason: string;
  readonly is_interrupt?: boolean | undefined;
}

export interface NotificationHookEvent extends HookEventBase<"Notification"> {
  readonly message: string;
  readonly notification_type:
    | "agent_completed"
    | "agent_needs_input"
    | "auth_success"
    | "elicitation_complete"
    | "elicitation_dialog"
    | "elicitation_response"
    | "idle_prompt"
    | "permission_prompt"
    | (string & {});
  readonly title?: string | undefined;
}

export interface SubagentStartHookEvent extends HookEventBase<"SubagentStart"> {
  readonly agent_id: string;
  readonly agent_type: string;
}

export interface SubagentStopHookEvent extends HookEventBase<"SubagentStop"> {
  readonly agent_id: string;
  readonly agent_transcript_path: string;
  readonly agent_type: string;
  readonly last_assistant_message?: string | undefined;
  readonly stop_hook_active: boolean;
}

export interface HookTask {
  readonly active_form?: string | undefined;
  readonly description?: string | undefined;
  readonly id: string;
  readonly owner?: string | undefined;
  readonly status: "completed" | "in_progress" | "pending";
  readonly subject: string;
}

export interface TaskCreatedHookEvent extends HookEventBase<"TaskCreated"> {
  readonly task: HookTask;
}

export interface TaskCompletedHookEvent extends HookEventBase<"TaskCompleted"> {
  readonly task: HookTask;
  readonly teammate_name?: string | undefined;
}

export interface StopHookEvent extends HookEventBase<"Stop"> {
  readonly last_assistant_message?: string | undefined;
  readonly stop_hook_active: boolean;
}

export interface StopFailureHookEvent extends HookEventBase<"StopFailure"> {
  readonly error: string;
  readonly error_type:
    | "authentication_failed"
    | "billing_error"
    | "invalid_request"
    | "max_output_tokens"
    | "model_not_found"
    | "oauth_org_not_allowed"
    | "overloaded"
    | "rate_limit"
    | "server_error"
    | "unknown";
}

export interface TeammateIdleHookEvent extends HookEventBase<"TeammateIdle"> {
  readonly team_name?: string | undefined;
  readonly teammate_name: string;
}

export interface ConfigChangeHookEvent extends HookEventBase<"ConfigChange"> {
  readonly file_path?: string | undefined;
  readonly source:
    | "local_settings"
    | "policy_settings"
    | "project_settings"
    | "skills"
    | "user_settings";
}

export interface CwdChangedHookEvent extends HookEventBase<"CwdChanged"> {
  readonly new_cwd: string;
  readonly old_cwd: string;
}

export interface FileChangedHookEvent extends HookEventBase<"FileChanged"> {
  readonly file_path: string;
}

export interface WorktreeCreateHookEvent extends HookEventBase<"WorktreeCreate"> {
  readonly name?: string | undefined;
}

export interface WorktreeRemoveHookEvent extends HookEventBase<"WorktreeRemove"> {
  readonly worktree_path: string;
}

export interface PreCompactHookEvent extends HookEventBase<"PreCompact"> {
  readonly custom_instructions?: string | undefined;
  readonly trigger: "auto" | "manual";
}

export interface PostCompactHookEvent extends HookEventBase<"PostCompact"> {
  readonly compact_summary?: string | undefined;
  readonly trigger: "auto" | "manual";
}

export interface SessionEndHookEvent extends HookEventBase<"SessionEnd"> {
  readonly reason:
    | "bypass_permissions_disabled"
    | "clear"
    | "logout"
    | "other"
    | "prompt_input_exit"
    | "resume";
}

export interface ElicitationHookEvent extends HookEventBase<"Elicitation"> {
  readonly mcp_server_name: string;
  readonly message: string;
  readonly mode?: "form" | "url" | undefined;
  readonly request_id: string;
  readonly requested_schema?: JsonObject | undefined;
}

export interface ElicitationResultHookEvent extends HookEventBase<"ElicitationResult"> {
  readonly action: "accept" | "cancel" | "decline";
  readonly mcp_server_name: string;
  readonly request_id: string;
  readonly result?: JsonValue | undefined;
}

export type HookEvent =
  | ConfigChangeHookEvent
  | CwdChangedHookEvent
  | ElicitationHookEvent
  | ElicitationResultHookEvent
  | FileChangedHookEvent
  | InstructionsLoadedHookEvent
  | MessageDisplayHookEvent
  | NotificationHookEvent
  | PermissionDeniedHookEvent
  | PermissionRequestHookEvent
  | PostCompactHookEvent
  | PostToolBatchHookEvent
  | PostToolUseFailureHookEvent
  | PostToolUseHookEvent
  | PreCompactHookEvent
  | PreToolUseHookEvent
  | SessionEndHookEvent
  | SessionStartHookEvent
  | SetupHookEvent
  | StopFailureHookEvent
  | StopHookEvent
  | SubagentStartHookEvent
  | SubagentStopHookEvent
  | TaskCompletedHookEvent
  | TaskCreatedHookEvent
  | TeammateIdleHookEvent
  | UserPromptExpansionHookEvent
  | UserPromptSubmitHookEvent
  | WorktreeCreateHookEvent
  | WorktreeRemoveHookEvent;

export interface HookSource {
  readonly componentId?: string | undefined;
  readonly path?: string | undefined;
  readonly priority: number;
  readonly type: HookSourceType;
}

export interface HookHandlerBase<TType extends HookExecutorType> {
  readonly if?: string | undefined;
  readonly once?: boolean | undefined;
  readonly statusMessage?: string | undefined;
  readonly timeout?: number | undefined;
  readonly type: TType;
}

export type HookCallback = (
  invocation: HookInvocation,
  context: HookExecutionContext,
) => HookHandlerOutput | Promise<HookHandlerOutput>;

export interface CallbackHookHandler extends HookHandlerBase<"callback"> {
  readonly callback: HookCallback;
  readonly name: string;
}

export interface CommandHookHandler extends HookHandlerBase<"command"> {
  readonly args?: readonly string[] | undefined;
  readonly async?: boolean | undefined;
  readonly asyncRewake?: boolean | undefined;
  readonly command: string;
  readonly shell?: string | undefined;
}

export interface HttpHookHandler extends HookHandlerBase<"http"> {
  readonly allowedEnvVars?: readonly string[] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly url: string;
}

export interface PromptHookHandler extends HookHandlerBase<"prompt"> {
  readonly model?: string | undefined;
  readonly prompt: string;
}

export interface AgentHookHandler extends HookHandlerBase<"agent"> {
  readonly maxTurns?: number | undefined;
  readonly model?: string | undefined;
  readonly prompt: string;
}

export interface McpHookHandler extends HookHandlerBase<"mcp"> {
  readonly arguments?: JsonObject | undefined;
  readonly server: string;
  readonly tool: string;
}

export type HookHandler =
  | AgentHookHandler
  | CallbackHookHandler
  | CommandHookHandler
  | HttpHookHandler
  | McpHookHandler
  | PromptHookHandler;

export interface HookInvocation {
  readonly event: HookEvent;
  readonly handler: HookHandler;
  readonly hookId: string;
  readonly invocationId: string;
  readonly parentInvocationId?: string | undefined;
  readonly source: HookSource;
}

export interface HookPermissionUpdate {
  readonly decision: HookPermissionDecision;
  readonly destination?: string | undefined;
  readonly rule?: string | undefined;
}

export interface HookDiagnostic {
  readonly code: string;
  readonly hookId?: string | undefined;
  readonly message: string;
  readonly severity: "error" | "info" | "warning";
}

export interface HookSpecificOutput {
  readonly additionalContext?: string | undefined;
  readonly hookEventName: string;
  readonly permissionDecision?: "allow" | "ask" | "deny" | undefined;
  readonly permissionDecisionReason?: string | undefined;
  readonly result?: JsonValue | undefined;
  readonly updatedInput?: JsonObject | undefined;
  readonly updatedValue?: JsonValue | undefined;
}

export interface HookHandlerOutput {
  readonly action?: HookAction | undefined;
  readonly additionalContext?: string | readonly string[] | undefined;
  readonly continue?: boolean | undefined;
  readonly decision?: "allow" | "block" | undefined;
  readonly hookSpecificOutput?: HookSpecificOutput | undefined;
  readonly permissionUpdates?: readonly HookPermissionUpdate[] | undefined;
  readonly reason?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly suppressOutput?: boolean | undefined;
  readonly systemMessage?: string | undefined;
  readonly updatedInput?: JsonObject | undefined;
}

export interface HookExecutionResult {
  readonly durationMs: number;
  readonly endedAt: string;
  readonly errorCode?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly output?: HookHandlerOutput | undefined;
  readonly startedAt: string;
  readonly status: HookExecutionStatus;
  readonly stderr?: string | undefined;
  readonly stdout?: string | undefined;
  readonly truncatedStderrBytes?: number | undefined;
  readonly truncatedStdoutBytes?: number | undefined;
}

export interface HookDecision {
  readonly action: HookAction;
  readonly additionalContext: readonly string[];
  readonly diagnostics: readonly HookDiagnostic[];
  readonly permissionUpdates: readonly HookPermissionUpdate[];
  readonly reasons: readonly string[];
  readonly suppressOutput: boolean;
  readonly systemMessages: readonly string[];
  readonly updatedInput?: JsonObject | undefined;
  readonly updatedValue?: JsonValue | undefined;
}

export interface HookExecutionContext {
  readonly deadline: number;
  readonly depth: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal | undefined;
}

export interface HookExecutor<THandler extends HookHandler = HookHandler> {
  readonly type: THandler["type"];
  execute(
    invocation: HookInvocation,
    handler: THandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult>;
}

export interface HookModelRunInput {
  readonly event: HookEvent;
  readonly maxOutputBytes: number;
  readonly model?: string | undefined;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface HookModelRunner {
  run(input: HookModelRunInput): Promise<HookHandlerOutput>;
}

export interface HookAgentRunInput extends HookModelRunInput {
  readonly maxTokens: number;
  readonly maxToolCalls: number;
  readonly maxTurns: number;
}

export interface HookAgentRunner {
  run(input: HookAgentRunInput): Promise<HookHandlerOutput>;
}

export interface HookMcpInvokeInput {
  readonly arguments: JsonObject;
  readonly event: HookEvent;
  readonly server: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly tool: string;
}

export interface HookMcpInvoker {
  invoke(input: HookMcpInvokeInput): Promise<HookHandlerOutput>;
}

export interface HookTrustRequest {
  readonly capability: string;
  readonly eventName?: HookEventName | undefined;
  readonly executorType: HookExecutorType;
  readonly handlerHash: string;
  readonly hookId: string;
  readonly opaque: boolean;
  readonly source: HookSource;
  readonly trustKey: string;
}

export interface HookTrustResponse {
  readonly decision: "allow" | "deny";
  readonly reason?: string | undefined;
  readonly scope?: "once" | "persistent" | undefined;
}

export type HookTrustApprovalHandler = (
  request: HookTrustRequest,
) => HookTrustResponse | Promise<HookTrustResponse>;
