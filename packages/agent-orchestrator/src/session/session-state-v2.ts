import { z } from "zod";

export const SESSION_STATE_V2_SCHEMA_VERSION = 2;

const identifierSchema = z.string().trim().min(1).max(256);
const boundedTextSchema = z.string().max(8_192);
const dateSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO date-time string.",
});
const toolEffectSchema = z.enum(["external", "process", "read", "write"]);
const taskStatusSchema = z.enum(["blocked", "completed", "in_progress", "pending"]);
const memoryKindSchema = z.enum(["decision", "episode", "fact", "preference", "procedure"]);
const workingMemorySourceSchema = z.enum([
  "operation",
  "prompt",
  "task",
  "turn-extract",
  "user-answer",
]);
const workingMemoryStatusSchema = z.enum(["active", "consolidated", "discarded"]);

const historyEntrySchema = z
  .object({
    content: z.string().min(1).max(32_768),
    role: z.enum(["assistant", "system", "user"]),
  })
  .strict();

const historySchema = z
  .object({
    entries: z.array(historyEntrySchema).max(500),
    summary: z.string().min(1).max(32_768).optional(),
  })
  .strict();

const budgetSchema = z
  .object({
    epoch: z.number().int().positive(),
    noProgressStages: z.number().int().nonnegative(),
    progressRevision: z.number().int().nonnegative(),
    stage: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    totalStages: z.number().int().nonnegative(),
  })
  .strict();

const taskSchema = z
  .object({
    active_form: boundedTextSchema.optional(),
    description: boundedTextSchema.optional(),
    id: identifierSchema,
    owner: identifierSchema.optional(),
    parent_id: identifierSchema.optional(),
    revision: z.number().int().positive(),
    status: taskStatusSchema,
    subject: z.string().trim().min(1).max(2_048),
  })
  .strict();

const legacySubagentSchema = z
  .object({
    agentKey: identifierSchema,
    id: identifierSchema,
    status: z.enum(["completed", "failed", "running"]),
    taskId: identifierSchema,
    transcriptFilePath: z.string().min(1).max(4_096).optional(),
  })
  .strict();

const operationBaseShape = {
  callId: identifierSchema,
  effect: toolEffectSchema,
  inputSummary: boundedTextSchema,
  stageId: identifierSchema,
  toolName: identifierSchema,
};

const inFlightOperationSchema = z
  .object({
    ...operationBaseShape,
    startedAt: dateSchema,
  })
  .strict();

const completedOperationSchema = z
  .object({
    ...operationBaseShape,
    completedAt: dateSchema,
    outputSummary: boundedTextSchema.optional(),
    status: z.enum(["failed", "succeeded"]),
  })
  .strict();

const pendingInputSchema = z
  .object({
    kind: z.enum(["elicitation", "permission", "side-effect-review"]),
    message: z.string().trim().min(1).max(8_192),
  })
  .strict();

const workingMemoryDraftSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    content: z.string().trim().min(1).max(32_768),
    expiresAt: dateSchema.optional(),
    importance: z.number().min(0).max(1),
    kind: memoryKindSchema,
    metadata: z.record(z.string(), z.json()).optional(),
    tags: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  })
  .strict();

const workingMemorySchema = z
  .object({
    consolidatedAt: dateSchema.optional(),
    content: z.string().trim().min(1).max(32_768),
    createdAt: dateSchema,
    draft: workingMemoryDraftSchema.optional(),
    id: identifierSchema,
    longTermMemoryId: identifierSchema.optional(),
    sessionId: identifierSchema,
    source: workingMemorySourceSchema,
    status: workingMemoryStatusSchema,
    updatedAt: dateSchema,
  })
  .strict();

const skillSnapshotSchema = z
  .object({
    agentTypes: z.array(identifierSchema).min(1).max(32),
    allowedTools: z.string().trim().min(1).max(4_096).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().min(1).max(1_024),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    instructions: z.string().max(64 * 1024),
    license: z.string().trim().min(1).max(4_096).optional(),
    metadata: z.record(z.string().trim().min(1), z.string()).optional(),
    mcpTargets: z.array(z.string().trim().min(1).max(256)).max(128),
    name: identifierSchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    path: z.string().trim().min(1).max(4_096),
    resolvedAt: dateSchema,
    source: z.enum(["builtin", "project", "user"]),
    version: z.string().trim().min(1).max(128),
  })
  .strict();

const subagentProfileSchema = z
  .object({
    accessMode: z.enum(["read-only", "read-write"]),
    agentType: identifierSchema,
    createdAt: dateSchema,
    createdBy: z.enum(["agent", "user"]),
    deliverable: z.string().trim().min(1).max(8_192),
    id: identifierSchema,
    instructions: z.string().trim().min(1).max(32_768),
    modelKey: identifierSchema,
    name: z.string().trim().min(1).max(128),
    role: z.string().trim().min(1).max(8_192),
    skillSnapshots: z.array(skillSnapshotSchema).max(24),
  })
  .strict();

const subagentInstanceSchema = z
  .object({
    agentId: identifierSchema,
    endedAt: dateSchema.optional(),
    error: boundedTextSchema.optional(),
    profileId: identifierSchema,
    startedAt: dateSchema,
    status: z.enum(["cancelled", "failed", "running", "succeeded"]),
    taskId: identifierSchema,
  })
  .strict();

export const sessionStateV2Schema = z
  .object({
    agentKey: identifierSchema,
    budget: budgetSchema,
    configFingerprint: identifierSchema,
    createdAt: dateSchema,
    history: historySchema,
    inFlightOperations: z.array(inFlightOperationSchema).max(1_000),
    lastCompletedOperation: completedOperationSchema.optional(),
    modelKey: identifierSchema,
    pendingInput: pendingInputSchema.optional(),
    revision: z.number().int().positive(),
    schemaVersion: z.literal(SESSION_STATE_V2_SCHEMA_VERSION),
    sessionId: identifierSchema.regex(/^[a-zA-Z0-9._-]+$/u),
    status: z.enum(["active", "completed", "failed", "needs-review", "paused"]),
    subagentInstances: z.array(subagentInstanceSchema).max(10_000),
    subagentProfiles: z.array(subagentProfileSchema).max(12),
    subagents: z.array(legacySubagentSchema).max(1_000),
    tasks: z.array(taskSchema).max(10_000),
    updatedAt: dateSchema,
    workingMemories: z.array(workingMemorySchema).max(500).default([]),
    workspaceDir: z.string().trim().min(1).max(4_096),
  })
  .strict();

export type SessionStateV2 = z.infer<typeof sessionStateV2Schema>;
