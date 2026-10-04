import { tool } from "@openai/agents";
import {
  executeTool,
  formatToolError,
  type ToolCallMetadata,
  type ToolExecutionMiddleware,
  type UserQuestionHandler,
} from "@yiku/agent-code";
import { z } from "zod";
import type {
  AgentManagementCreateOptions,
  AgentManagementRunOptions,
  SubagentRunResult,
} from "../agents/agent-management-service.js";
import type { AgentCreationRequest } from "../session/agent-creation-broker.js";
import type { SessionSubagentProfile } from "../session/session-state.js";
import type { Skill } from "./types.js";

const emptyInputSchema = z.object({}).strict();
const createInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(8_192).optional(),
  })
  .strict();
const profileInputSchema = z
  .object({
    profile_id: z.string().trim().min(1).max(256),
  })
  .strict();
const runInputSchema = profileInputSchema
  .extend({
    prompt: z.string().trim().min(1).max(16_384),
  })
  .strict();

export interface AgentManagementServiceContract {
  create(
    request: AgentCreationRequest,
    options: AgentManagementCreateOptions,
  ): Promise<SessionSubagentProfile>;
  list(): Promise<readonly SessionSubagentProfile[]>;
  remove(profileId: string): Promise<void>;
  run(
    profileId: string,
    prompt: string,
    options?: AgentManagementRunOptions,
  ): Promise<SubagentRunResult>;
  show(profileId: string): Promise<SessionSubagentProfile>;
}

export interface CreateAgentManagementSkillOptions {
  readonly confirmRemove?:
    | ((profile: SessionSubagentProfile) => Promise<boolean> | boolean)
    | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly profiles?: readonly SessionSubagentProfile[] | undefined;
  readonly questionHandler?: UserQuestionHandler | undefined;
  readonly service: AgentManagementServiceContract;
}

export function createAgentManagementSkill(options: CreateAgentManagementSkillOptions): Skill {
  return Object.freeze({
    description: "Create and run Session-scoped Subagent Profiles.",
    instructions: agentManagementInstructions(options.profiles ?? []),
    name: "agents",
    tools: Object.freeze([
      tool({
        description: "List Session-scoped Subagent Profiles.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (input: unknown, _context?: unknown, details?: ToolCallMetadata) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "read",
              execute: async () =>
                JSON.stringify((await options.service.list()).map(summarizeProfile)),
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "agentListTool",
              validate: (value) => emptyInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "agentListTool",
        parameters: emptyInputSchema,
        strict: true,
      }),
      tool({
        description:
          "Create a Session-scoped Subagent Profile through an interactive requirements review.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (input: z.infer<typeof createInputSchema>, _context, details?: ToolCallMetadata) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "write",
              execute: async (resolved) => {
                if (options.questionHandler === undefined) {
                  throw new Error("Subagent creation requires an interactive question handler.");
                }
                return JSON.stringify(
                  await options.service.create(
                    resolved.intent === undefined ? {} : { intent: resolved.intent },
                    {
                      createdBy: "agent",
                      questionHandler: options.questionHandler,
                      ...(details?.signal !== undefined ? { signal: details.signal } : {}),
                    },
                  ),
                );
              },
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "agentCreateTool",
              validate: (value) => createInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "agentCreateTool",
        parameters: createInputSchema,
        strict: true,
      }),
      tool({
        description: "Run one Session-scoped Subagent Profile on a bounded task.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (input: z.infer<typeof runInputSchema>, _context, details?: ToolCallMetadata) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "write",
              execute: (resolved) =>
                options.service
                  .run(resolved.profile_id, resolved.prompt, {
                    ...(details?.toolCall?.callId !== undefined
                      ? { parentToolCallId: details.toolCall.callId }
                      : {}),
                    ...(details?.signal !== undefined ? { signal: details.signal } : {}),
                  })
                  .then((result) => JSON.stringify(result)),
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "agentRunTool",
              validate: (value) => runInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "agentRunTool",
        parameters: runInputSchema,
        strict: true,
      }),
      tool({
        description: "Remove an idle Session-scoped Subagent Profile after confirmation.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (
          input: z.infer<typeof profileInputSchema>,
          _context,
          details?: ToolCallMetadata,
        ) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "write",
              execute: async (resolved) => {
                if (options.confirmRemove === undefined) {
                  throw new Error("Subagent removal requires confirmation.");
                }
                const profile = await options.service.show(resolved.profile_id);
                if (!(await options.confirmRemove(profile))) {
                  throw new Error("Subagent Profile removal was cancelled.");
                }
                await options.service.remove(profile.id);
                return JSON.stringify({ profileId: profile.id, removed: true });
              },
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "agentRemoveTool",
              validate: (value) => profileInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "agentRemoveTool",
        parameters: profileInputSchema,
        strict: true,
      }),
    ]),
  });
}

function summarizeProfile(profile: SessionSubagentProfile) {
  return {
    accessMode: profile.accessMode,
    agentType: profile.agentType,
    createdBy: profile.createdBy,
    id: profile.id,
    invocationMode: profile.invocationMode,
    modelKey: profile.modelKey,
    name: profile.name,
    purpose: profile.purpose,
    role: profile.role,
    scopes: profile.scopes,
    skills: profile.skillSnapshots.map((skill) => skill.name),
    ...(profile.triggerInstructions !== undefined
      ? { triggerInstructions: profile.triggerInstructions }
      : {}),
  };
}

function agentManagementInstructions(profiles: readonly SessionSubagentProfile[]): string {
  const policy = [
    "Use Session-scoped Subagent Profiles through agentRunTool.",
    "Run a proactive Profile when the current user communication matches its purpose and scopes,",
    "or when the user explicitly asks to trigger it.",
    "Run a manual Profile only when the user or the main Agent explicitly names it.",
    "Pass one bounded task prompt and incorporate the structured result into the final response.",
  ].join(" ");
  if (profiles.length === 0) {
    return `${policy} No Subagent Profiles are currently configured.`;
  }
  return [
    policy,
    "Configured Subagent Profiles:",
    JSON.stringify(profiles.map(summarizeProfile)),
  ].join("\n");
}
