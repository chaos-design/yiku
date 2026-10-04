import { dirname } from "node:path";
import { tool } from "@openai/agents";
import {
  executeTool,
  formatToolError,
  type ToolCallMetadata,
  type ToolExecutionMiddleware,
} from "@yiku/agent-code";
import { z } from "zod";
import type { AgentProgressHandler } from "../runtime/types.js";
import type { SkillRuntime } from "./skill-runtime.js";
import type { SkillWorker } from "./skill-worker.js";
import type { Skill } from "./types.js";

const emptyInputSchema = z.object({}).strict();
const inspectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
  })
  .strict();
const runInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(16_384),
    skill_name: z.string().trim().min(1).max(64),
  })
  .strict();

export interface CreateSkillRuntimeSkillOptions {
  readonly agentType?: string | undefined;
  readonly inspectMaxCharacters?: number | undefined;
  readonly middleware?: ToolExecutionMiddleware | undefined;
  readonly onEvent?: AgentProgressHandler | undefined;
  readonly runtime: SkillRuntime;
  readonly worker: SkillWorker;
}

export function createSkillRuntimeSkill(options: CreateSkillRuntimeSkillOptions): Skill {
  const agentType = options.agentType ?? "code";
  const inspectMaxCharacters = options.inspectMaxCharacters ?? 8_192;
  if (!Number.isSafeInteger(inspectMaxCharacters) || inspectMaxCharacters <= 0) {
    throw new Error("Skill inspect character limit must be a positive integer.");
  }

  return Object.freeze({
    description: "Discover, inspect, and run bounded local Skills.",
    instructions: skillCatalogInstructions(options.runtime),
    name: "skills",
    tools: Object.freeze([
      tool({
        description: "List discovered Skills with source, version, and compatible Agent types.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (input: unknown, _context?: unknown, details?: ToolCallMetadata) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "read",
              execute: () =>
                Promise.resolve(
                  JSON.stringify(
                    options.runtime.list().map((skill) => ({
                      agentTypes: skill.agentTypes,
                      description: skill.description,
                      digest: skill.digest,
                      name: skill.name,
                      source: skill.source,
                      version: skill.version,
                    })),
                  ),
                ),
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "skillListTool",
              validate: (value) => emptyInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "skillListTool",
        parameters: emptyInputSchema,
        strict: true,
      }),
      tool({
        description: "Inspect one discovered Skill without activating it.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (
          input: z.infer<typeof inspectInputSchema>,
          _context,
          details?: ToolCallMetadata,
        ) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "read",
              execute: (resolved) => {
                const skill = options.runtime.inspect(resolved.name);
                if (skill === undefined) {
                  return Promise.reject(new Error(`Unknown Skill: ${resolved.name}.`));
                }
                return Promise.resolve(
                  JSON.stringify({
                    agentTypes: skill.agentTypes,
                    ...(skill.allowedTools === undefined
                      ? {}
                      : { allowedTools: skill.allowedTools }),
                    ...(skill.compatibility === undefined
                      ? {}
                      : { compatibility: skill.compatibility }),
                    description: skill.description,
                    digest: skill.digest,
                    instructions: truncate(skill.instructions, inspectMaxCharacters),
                    ...(skill.license === undefined ? {} : { license: skill.license }),
                    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
                    mcpTargets: skill.mcpTargets,
                    name: skill.name,
                    path: skill.path,
                    root: dirname(skill.path),
                    source: skill.source,
                    version: skill.version,
                  }),
                );
              },
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "skillInspectTool",
              validate: (value) => inspectInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "skillInspectTool",
        parameters: inspectInputSchema,
        strict: true,
      }),
      tool({
        description:
          "Run one discovered Skill in a bounded worker. This does not modify the parent Agent.",
        errorFunction: (_context: unknown, error: unknown) => formatToolError(error),
        execute: (input: z.infer<typeof runInputSchema>, _context, details?: ToolCallMetadata) =>
          executeTool(
            {
              ...(details?.toolCall?.callId !== undefined
                ? { callId: details.toolCall.callId }
                : {}),
              effect: "read",
              execute: async (resolved) => {
                const [snapshot] = options.runtime.snapshot([resolved.skill_name], agentType);
                if (snapshot === undefined) {
                  throw new Error(`Unknown Skill: ${resolved.skill_name}.`);
                }
                options.onEvent?.({
                  digest: snapshot.digest,
                  name: snapshot.name,
                  source: snapshot.source,
                  type: "skill_resolved",
                });
                options.onEvent?.({
                  name: snapshot.name,
                  targetId: details?.toolCall?.callId ?? "skill-worker",
                  type: "skill_activated",
                });
                return JSON.stringify(
                  await options.worker.run(snapshot, resolved.prompt, details?.signal),
                );
              },
              input,
              ...(details?.signal !== undefined ? { signal: details.signal } : {}),
              toolName: "skillRunTool",
              validate: (value) => runInputSchema.parse(value),
            },
            options.middleware,
          ),
        name: "skillRunTool",
        parameters: runInputSchema,
        strict: true,
      }),
    ]),
  });
}

function skillCatalogInstructions(runtime: SkillRuntime): string {
  const catalog = runtime
    .list()
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
  return [
    "# Available Skills",
    "",
    "Use the metadata below to decide whether a Skill is relevant to the user's task.",
    "When a Skill matches, call skillInspectTool before following it so its instructions and root directory are loaded on demand.",
    "Use skillRunTool only when the task should run in an isolated read-only worker.",
    "Do not inspect or run unrelated Skills.",
    "",
    catalog || "- No discovered Skills are available.",
  ].join("\n");
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const suffix = "\n[truncated]";
  return `${value.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}
