import { z } from "zod";
import type { HookEvent, HookEventName, JsonObject, JsonValue } from "../types.js";

const text = z.string().min(1);
const jsonPrimitiveSchema = z.union([z.boolean(), z.null(), z.number().finite(), z.string()]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const baseHookEventSchema = z
  .object({
    cwd: text,
    permission_mode: text,
    session_id: text,
    transcript_path: text,
  })
  .strict();

const sessionStartSchema = baseHookEventSchema
  .extend({
    agent_type: text.optional(),
    hook_event_name: z.literal("SessionStart"),
    model: text.optional(),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .strict();

const setupSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("Setup"),
    trigger: z.enum(["init", "maintenance"]),
  })
  .strict();

const instructionsLoadedSchema = baseHookEventSchema
  .extend({
    file_path: text,
    hook_event_name: z.literal("InstructionsLoaded"),
    load_reason: z.enum([
      "session_start",
      "nested_traversal",
      "path_glob_match",
      "include",
      "compact",
    ]),
    memory_type: text.optional(),
  })
  .strict();

const userPromptSubmitSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z.string(),
  })
  .strict();

const userPromptExpansionSchema = baseHookEventSchema
  .extend({
    command_args: z.string().optional(),
    command_name: text,
    hook_event_name: z.literal("UserPromptExpansion"),
    prompt: z.string(),
  })
  .strict();

const messageDisplaySchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("MessageDisplay"),
    message: z.string(),
  })
  .strict();

const toolEventShape = {
  tool_input: jsonObjectSchema,
  tool_name: text,
  tool_use_id: text,
};

const preToolUseSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("PreToolUse"),
    ...toolEventShape,
  })
  .strict();

const permissionRequestSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("PermissionRequest"),
    permission_suggestions: z.array(jsonObjectSchema).optional(),
    ...toolEventShape,
  })
  .strict();

const postToolUseSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("PostToolUse"),
    tool_response: jsonValueSchema,
    ...toolEventShape,
  })
  .strict();

const postToolUseFailureSchema = baseHookEventSchema
  .extend({
    error: text,
    hook_event_name: z.literal("PostToolUseFailure"),
    is_interrupt: z.boolean().optional(),
    ...toolEventShape,
  })
  .strict();

const postToolBatchSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("PostToolBatch"),
    results: z.array(
      z
        .object({
          status: z.enum(["failed", "succeeded"]),
          tool_name: text,
          tool_use_id: text,
        })
        .strict(),
    ),
  })
  .strict();

const permissionDeniedSchema = baseHookEventSchema
  .extend({
    denial_reason: text,
    hook_event_name: z.literal("PermissionDenied"),
    is_interrupt: z.boolean().optional(),
    ...toolEventShape,
  })
  .strict();

const notificationSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("Notification"),
    message: z.string(),
    notification_type: text,
    title: z.string().optional(),
  })
  .strict();

const subagentStartSchema = baseHookEventSchema
  .extend({
    agent_id: text,
    agent_type: text,
    hook_event_name: z.literal("SubagentStart"),
  })
  .strict();

const subagentStopSchema = baseHookEventSchema
  .extend({
    agent_id: text,
    agent_transcript_path: text,
    agent_type: text,
    hook_event_name: z.literal("SubagentStop"),
    last_assistant_message: z.string().optional(),
    stop_hook_active: z.boolean(),
  })
  .strict();

const hookTaskSchema = z
  .object({
    active_form: z.string().optional(),
    description: z.string().optional(),
    id: text,
    owner: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed"]),
    subject: text,
  })
  .strict();

const taskCreatedSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("TaskCreated"),
    task: hookTaskSchema,
  })
  .strict();

const taskCompletedSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("TaskCompleted"),
    task: hookTaskSchema,
    teammate_name: z.string().optional(),
  })
  .strict();

const stopSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("Stop"),
    last_assistant_message: z.string().optional(),
    stop_hook_active: z.boolean(),
  })
  .strict();

const stopFailureSchema = baseHookEventSchema
  .extend({
    error: text,
    error_type: z.enum([
      "rate_limit",
      "overloaded",
      "authentication_failed",
      "oauth_org_not_allowed",
      "billing_error",
      "invalid_request",
      "model_not_found",
      "server_error",
      "max_output_tokens",
      "unknown",
    ]),
    hook_event_name: z.literal("StopFailure"),
  })
  .strict();

const teammateIdleSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("TeammateIdle"),
    team_name: z.string().optional(),
    teammate_name: text,
  })
  .strict();

const configChangeSchema = baseHookEventSchema
  .extend({
    file_path: z.string().optional(),
    hook_event_name: z.literal("ConfigChange"),
    source: z.enum([
      "user_settings",
      "project_settings",
      "local_settings",
      "policy_settings",
      "skills",
    ]),
  })
  .strict();

const cwdChangedSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("CwdChanged"),
    new_cwd: text,
    old_cwd: text,
  })
  .strict();

const fileChangedSchema = baseHookEventSchema
  .extend({
    file_path: text,
    hook_event_name: z.literal("FileChanged"),
  })
  .strict();

const worktreeCreateSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("WorktreeCreate"),
    name: z.string().optional(),
  })
  .strict();

const worktreeRemoveSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("WorktreeRemove"),
    worktree_path: text,
  })
  .strict();

const preCompactSchema = baseHookEventSchema
  .extend({
    custom_instructions: z.string().optional(),
    hook_event_name: z.literal("PreCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const postCompactSchema = baseHookEventSchema
  .extend({
    compact_summary: z.string().optional(),
    hook_event_name: z.literal("PostCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const sessionEndSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("SessionEnd"),
    reason: z.enum([
      "clear",
      "resume",
      "logout",
      "prompt_input_exit",
      "bypass_permissions_disabled",
      "other",
    ]),
  })
  .strict();

const elicitationSchema = baseHookEventSchema
  .extend({
    hook_event_name: z.literal("Elicitation"),
    mcp_server_name: text,
    message: z.string(),
    mode: z.enum(["form", "url"]).optional(),
    request_id: text,
    requested_schema: jsonObjectSchema.optional(),
  })
  .strict();

const elicitationResultSchema = baseHookEventSchema
  .extend({
    action: z.enum(["accept", "decline", "cancel"]),
    hook_event_name: z.literal("ElicitationResult"),
    mcp_server_name: text,
    request_id: text,
    result: jsonValueSchema.optional(),
  })
  .strict();

export const HOOK_EVENT_SCHEMAS = Object.freeze({
  ConfigChange: configChangeSchema,
  CwdChanged: cwdChangedSchema,
  Elicitation: elicitationSchema,
  ElicitationResult: elicitationResultSchema,
  FileChanged: fileChangedSchema,
  InstructionsLoaded: instructionsLoadedSchema,
  MessageDisplay: messageDisplaySchema,
  Notification: notificationSchema,
  PermissionDenied: permissionDeniedSchema,
  PermissionRequest: permissionRequestSchema,
  PostCompact: postCompactSchema,
  PostToolBatch: postToolBatchSchema,
  PostToolUse: postToolUseSchema,
  PostToolUseFailure: postToolUseFailureSchema,
  PreCompact: preCompactSchema,
  PreToolUse: preToolUseSchema,
  SessionEnd: sessionEndSchema,
  SessionStart: sessionStartSchema,
  Setup: setupSchema,
  Stop: stopSchema,
  StopFailure: stopFailureSchema,
  SubagentStart: subagentStartSchema,
  SubagentStop: subagentStopSchema,
  TaskCompleted: taskCompletedSchema,
  TaskCreated: taskCreatedSchema,
  TeammateIdle: teammateIdleSchema,
  UserPromptExpansion: userPromptExpansionSchema,
  UserPromptSubmit: userPromptSubmitSchema,
  WorktreeCreate: worktreeCreateSchema,
  WorktreeRemove: worktreeRemoveSchema,
} satisfies Readonly<Record<HookEventName, z.ZodType>>);

export const hookEventSchema = z.discriminatedUnion("hook_event_name", [
  sessionStartSchema,
  setupSchema,
  instructionsLoadedSchema,
  userPromptSubmitSchema,
  userPromptExpansionSchema,
  messageDisplaySchema,
  preToolUseSchema,
  permissionRequestSchema,
  postToolUseSchema,
  postToolUseFailureSchema,
  postToolBatchSchema,
  permissionDeniedSchema,
  notificationSchema,
  subagentStartSchema,
  subagentStopSchema,
  taskCreatedSchema,
  taskCompletedSchema,
  stopSchema,
  stopFailureSchema,
  teammateIdleSchema,
  configChangeSchema,
  cwdChangedSchema,
  fileChangedSchema,
  worktreeCreateSchema,
  worktreeRemoveSchema,
  preCompactSchema,
  postCompactSchema,
  sessionEndSchema,
  elicitationSchema,
  elicitationResultSchema,
]);

export function parseHookEvent(value: unknown): HookEvent {
  return hookEventSchema.parse(value) as HookEvent;
}
