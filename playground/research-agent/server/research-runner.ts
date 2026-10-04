import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentProgressEvent,
  createRegisteredAgent,
  ResearchAgentFactory,
  recordRuntimeAtomicEvent,
  resolveModelConfig,
  run,
} from "@yiku/agent-orchestrator";
import type { ResearchReportValidation } from "@yiku/agent-research";
import {
  type EnvVars,
  loadEnvFile,
  loadModelsConfig,
  type ModelsConfig,
  mergeConfig,
  mergeEnv,
} from "@yiku/config";
import type {
  ResearchExecutionInput,
  ResearchExecutionResult,
  ResearchRunExecutor,
  ResearchSkillId,
} from "./types.js";

export interface ResearchRunnerOptions {
  readonly cwd?: string | undefined;
  readonly env?: EnvVars | undefined;
  readonly homeDir?: string | undefined;
  readonly modelsConfig?: ModelsConfig | undefined;
}

export class ResearchRunner implements ResearchRunExecutor {
  private readonly cwd: string;
  private readonly env?: EnvVars | undefined;
  private readonly homeDir: string;
  private readonly modelsConfig?: ModelsConfig | undefined;

  public constructor(options: ResearchRunnerOptions = {}) {
    this.cwd = resolve(options.cwd ?? (process.env.INIT_CWD?.trim() || process.cwd()));
    this.env = options.env;
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.modelsConfig = options.modelsConfig;
  }

  public async execute(input: ResearchExecutionInput): Promise<ResearchExecutionResult> {
    const env = this.resolveEnv();
    const config = resolveModelConfig({
      env,
      modelsConfig: this.resolveModelsConfig(),
    });
    const searchContextSize =
      input.searchContextSize ?? resolveSearchContextSize(env.AI_SEARCH_CONTEXT_SIZE);
    const instructions = [
      skillInstructions(input.skill),
      input.instructions?.trim(),
      config.instructions?.trim(),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const created = createRegisteredAgent(
      new ResearchAgentFactory({
        ...(searchContextSize !== undefined ? { searchContextSize } : {}),
      }),
      {
        agentName: env.AI_RESEARCH_AGENT_NAME?.trim() || "Yiku Research Agent",
        handoffs: [],
        ...(instructions ? { instructions } : {}),
        model: config.model,
        tools: [],
        workspaceDir: this.cwd,
      },
      {
        agentId: `${input.atomicFlow.runId}:research`,
        agentKey: "research",
        agentType: "research",
      },
    );
    const researchPrompt = conversationPrompt(input.history ?? [], input.prompt);
    const skillExecution = beginSkillExecution(input, searchContextSize);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(created.agent, researchPrompt, {
        apiKey: config.apiKey,
        atomicFlow: input.atomicFlow,
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
        model: config.model,
        onEvent: input.onEvent,
        signal: input.signal,
      });
      finishSkillExecution(
        input,
        skillExecution,
        result.stopReason === undefined || result.stopReason === "completed",
      );
    } catch (error) {
      finishSkillExecution(input, skillExecution, false);
      throw error;
    }
    const validation = asResearchValidation(result.outputValidation?.details);

    return {
      evidence: created.evidenceSnapshot(),
      ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
      model: config.model,
      ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(validation !== undefined ? { validation } : {}),
    };
  }

  private resolveEnv(): EnvVars {
    return mergeEnv(
      loadEnvFile({ filePath: join(this.homeDir, ".yiku", ".env") }),
      process.env,
      loadEnvFile({ cwd: this.cwd }),
      this.env ?? {},
    );
  }

  private resolveModelsConfig(): ModelsConfig {
    return (
      this.modelsConfig ??
      mergeConfig(
        loadModelsConfig({ homeDir: this.homeDir }),
        loadModelsConfig({ configPath: join(this.cwd, "config.yaml") }),
      )
    );
  }
}

interface SkillExecution {
  readonly name: string;
  readonly workerId: string;
}

function beginSkillExecution(
  input: ResearchExecutionInput,
  searchContextSize: "high" | "low" | "medium" | undefined,
): SkillExecution {
  const name = input.skill;
  const workerId = `${input.atomicFlow.runId}:${name}`;
  const digest = createHash("sha256")
    .update(
      `${name}:${searchContextSize ?? "provider-default"}:${input.instructions?.trim() ?? ""}`,
    )
    .digest("hex");
  publishSkillEvent(input, {
    digest,
    name,
    source: "builtin",
    type: "skill_resolved",
  });
  publishSkillEvent(input, {
    name,
    targetId: input.atomicFlow.runId,
    type: "skill_activated",
  });
  publishSkillEvent(input, {
    name,
    type: "skill_worker_started",
    workerId,
  });
  return { name, workerId };
}

function finishSkillExecution(
  input: ResearchExecutionInput,
  execution: SkillExecution,
  succeeded: boolean,
): void {
  publishSkillEvent(input, {
    name: execution.name,
    status: succeeded ? "succeeded" : "failed",
    type: "skill_worker_finished",
    workerId: execution.workerId,
  });
}

function publishSkillEvent(input: ResearchExecutionInput, event: AgentProgressEvent): void {
  recordRuntimeAtomicEvent(input.atomicFlow, event);
  input.onEvent(event);
}

function conversationPrompt(
  history: NonNullable<ResearchExecutionInput["history"]>,
  prompt: string,
): string {
  const recentHistory = history.slice(-12);
  if (recentHistory.length === 0) {
    return prompt;
  }
  const transcript = recentHistory
    .map((message) => `${message.role === "user" ? "User" : "Research Agent"}:\n${message.content}`)
    .join("\n\n")
    .slice(-32_000);
  return [
    "Continue the research conversation using the completed messages below as context.",
    "Re-check evidence when the new request depends on time-sensitive or disputed facts.",
    "",
    "<conversation_history>",
    transcript,
    "</conversation_history>",
    "",
    "<current_request>",
    prompt,
    "</current_request>",
  ].join("\n");
}

function resolveSearchContextSize(
  value: string | undefined,
): "high" | "low" | "medium" | undefined {
  const normalized = value?.trim().toLowerCase();

  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (normalized === "high" || normalized === "low" || normalized === "medium") {
    return normalized;
  }

  throw new Error("AI_SEARCH_CONTEXT_SIZE must be low, medium, or high.");
}

function skillInstructions(skill: ResearchSkillId): string | undefined {
  if (skill === "quick-research") {
    return [
      "Use a tightly bounded research strategy.",
      "Prioritize one authoritative primary source, stop once the claim is verified, and answer concisely.",
    ].join(" ");
  }
  if (skill === "deep-research") {
    return [
      "Use a broad research strategy for complex or disputed questions.",
      "Triangulate important claims across multiple independent sources and preserve material uncertainty.",
    ].join(" ");
  }
  return undefined;
}

function asResearchValidation(value: unknown): ResearchReportValidation | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<ResearchReportValidation>;
  return Array.isArray(candidate.diagnostics) &&
    candidate.diagnostics.every((diagnostic) => typeof diagnostic === "string") &&
    typeof candidate.evidenceCount === "number" &&
    typeof candidate.passed === "boolean" &&
    typeof candidate.primarySourceCount === "number"
    ? (candidate as ResearchReportValidation)
    : undefined;
}
