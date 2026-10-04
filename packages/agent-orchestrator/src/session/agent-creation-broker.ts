import type {
  UserQuestionHandler,
  UserQuestionRequest,
  UserQuestionResponse,
} from "@yiku/agent-code";
import { normalizeUserQuestionResponse } from "@yiku/agent-code";
import type { CreateSubagentProfileInput } from "../agents/session-agent-registry.js";
import type { SkillRuntime } from "../skills/skill-runtime.js";
import type {
  AgentProfileDraft,
  AgentProfileGenerationInput,
  AgentProfileGenerator,
  AgentProfileInvocationMode,
  AgentProfilePurpose,
  AgentProfileRequirements,
  AgentWorkspaceScope,
} from "./agent-profile.js";
import type { SessionSubagentProfile } from "./session-state.js";

export type AgentCreationErrorCode =
  | "AGENT_CREATION_CANCELLED"
  | "AGENT_CREATION_INPUT_REQUIRED"
  | "AGENT_PROFILE_GENERATION_FAILED"
  | "AGENT_TYPE_UNKNOWN";

export class AgentCreationError extends Error {
  public override readonly name = "AgentCreationError";

  public constructor(
    public readonly code: AgentCreationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AgentCreationRequest {
  readonly intent?: string | undefined;
}

export interface AgentCreationOptions {
  readonly createdBy: "agent" | "user";
  readonly questionHandler?: UserQuestionHandler | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AgentCreationRegistry {
  create(input: CreateSubagentProfileInput): Promise<SessionSubagentProfile>;
}

export interface AgentCreationBrokerOptions {
  readonly agentTypes: readonly string[];
  readonly currentModelKey: string;
  readonly generator: AgentProfileGenerator;
  readonly modelKeys: readonly string[];
  readonly parentAccessMode: "read-only" | "read-write";
  readonly registry: AgentCreationRegistry;
  readonly scopes: readonly AgentWorkspaceScope[];
  readonly skillRuntime: SkillRuntime;
}

export class AgentCreationBroker {
  public constructor(private readonly options: AgentCreationBrokerOptions) {}

  public async create(
    request: AgentCreationRequest,
    creation: AgentCreationOptions,
  ): Promise<SessionSubagentProfile> {
    const agentTypes = unique(this.options.agentTypes);
    if (agentTypes.length === 0) {
      throw new AgentCreationError("AGENT_TYPE_UNKNOWN", "No Agent types are available.");
    }
    const intent = request.intent?.trim();
    let requirements: AgentProfileRequirements;
    try {
      requirements =
        intent !== undefined && intent.length > 0
          ? { intent }
          : await this.askRequirements(creation.questionHandler);
    } catch (error) {
      if (error instanceof AgentCreationError) {
        throw error;
      }
      throw new AgentCreationError(
        "AGENT_CREATION_CANCELLED",
        "Subagent Profile creation was cancelled.",
        { cause: error },
      );
    }
    const generationInput: AgentProfileGenerationInput = {
      agentTypes,
      availableScopes: resolvedScopes(this.options.scopes),
      currentModelKey: this.options.currentModelKey,
      modelKeys: unique([this.options.currentModelKey, ...this.options.modelKeys]),
      parentAccessMode: this.options.parentAccessMode,
      requirements,
      skills: this.options.skillRuntime.list(),
    };

    const generated = await this.generate(generationInput, creation.signal);
    const skillSnapshots = this.options.skillRuntime.snapshot(
      generated.skillNames,
      generated.agentType,
    );
    return this.options.registry.create({
      accessMode: generated.accessMode,
      agentType: generated.agentType,
      createdBy: creation.createdBy,
      deliverable: generated.deliverable,
      description: generated.description,
      instructions: generated.instructions,
      invocationMode: generated.invocationMode,
      modelKey: generated.modelKey,
      name: generated.name,
      purpose: generated.purpose,
      role: generated.role,
      scopes: [...generated.scopes],
      skillSnapshots: skillSnapshots.map((snapshot) => ({
        ...snapshot,
        agentTypes: [...snapshot.agentTypes],
        mcpTargets: [...snapshot.mcpTargets],
      })),
      ...(generated.triggerInstructions !== undefined
        ? { triggerInstructions: generated.triggerInstructions }
        : {}),
    });
  }

  private async askRequirements(
    handler: UserQuestionHandler | undefined,
  ): Promise<AgentProfileRequirements> {
    if (handler === undefined) {
      throw new AgentCreationError(
        "AGENT_CREATION_INPUT_REQUIRED",
        "Subagent creation requires an interactive question handler or a one-line description.",
      );
    }
    const scopes = resolvedScopes(this.options.scopes);
    const request: UserQuestionRequest = {
      description:
        "我需要先了解你想创建的 subagent 需求，才能生成配置。请回答以下几个问题（也可直接用文字描述你的想法）。",
      questions: [
        {
          header: "核心用途",
          multiSelect: false,
          options: [
            {
              description: "审查最近编写的代码，发现逻辑、安全和规范问题",
              label: "代码审查",
            },
            {
              description: "为指定模块生成或修复单元测试",
              label: "测试生成",
            },
            {
              description: "在代码库中查找、理解并解释实现",
              label: "代码探索/研究",
            },
            {
              description: "根据需求编写或修改代码实现功能",
              label: "功能实现",
            },
          ],
          question: "这个 subagent 主要负责什么任务？",
        },
        {
          header: "技术范围",
          multiSelect: true,
          options: scopes.map((scope) => ({
            description: scope.description,
            label: scope.label,
          })),
          question: "主要工作在哪个技术栈/区域？",
        },
        {
          header: "主动性",
          multiSelect: false,
          options: [
            {
              description: "由主 Agent 根据交流判断，或在匹配触发指令时运行",
              label: "主动调用",
            },
            {
              description: "仅在用户或主 Agent 明确点名时运行",
              label: "手动调用",
            },
          ],
          question: "是否希望该 agent 被主动调用？",
        },
      ],
      title: "AskUserQuestion(核心用途，技术范围，主动性)",
    };
    const rawResponse = await handler(request);
    let response: UserQuestionResponse;
    try {
      response = normalizeUserQuestionResponse(request, rawResponse);
    } catch (error) {
      throw new AgentCreationError(
        "AGENT_CREATION_INPUT_REQUIRED",
        "Subagent creation requires valid answers for all three questions.",
        { cause: error },
      );
    }
    return requirementsFromResponse(response, scopes);
  }

  private async generate(
    input: AgentProfileGenerationInput,
    signal: AbortSignal | undefined,
  ): Promise<AgentProfileDraft> {
    try {
      return await this.options.generator.generate(input, {
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      throw new AgentCreationError(
        "AGENT_PROFILE_GENERATION_FAILED",
        `Subagent Profile generation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

function requirementsFromResponse(
  response: UserQuestionResponse,
  scopes: readonly AgentWorkspaceScope[],
): AgentProfileRequirements {
  if ("answer" in response) {
    throw new AgentCreationError(
      "AGENT_CREATION_INPUT_REQUIRED",
      "Subagent creation requires answers for all three questions.",
    );
  }
  const answers = new Map(response.answers.map((answer) => [answer.questionIndex, answer.answers]));
  const purposeAnswer = requiredAnswer(answers, 0);
  const scopeAnswers = requiredAnswers(answers, 1);
  const invocationAnswer = requiredAnswer(answers, 2);
  const scopeByLabel = new Map(scopes.map((scope) => [scope.label, scope.path]));
  const purpose = purposeFromAnswer(purposeAnswer);
  const invocation = invocationFromAnswer(invocationAnswer);

  return Object.freeze({
    invocationMode: invocation.mode,
    purpose,
    scopes: Object.freeze(unique(scopeAnswers.map((answer) => scopeByLabel.get(answer) ?? answer))),
    ...(invocation.triggerInstructions !== undefined
      ? { triggerInstructions: invocation.triggerInstructions }
      : {}),
  });
}

function purposeFromAnswer(answer: string): AgentProfilePurpose {
  switch (answer) {
    case "代码审查":
      return "code-review";
    case "测试生成":
      return "test-generation";
    case "代码探索/研究":
      return "code-research";
    case "功能实现":
      return "feature-implementation";
    default:
      return "custom";
  }
}

function invocationFromAnswer(answer: string): {
  readonly mode: AgentProfileInvocationMode;
  readonly triggerInstructions?: string | undefined;
} {
  if (answer === "手动调用") {
    return { mode: "manual" };
  }
  if (answer === "主动调用") {
    return { mode: "proactive" };
  }
  return {
    mode: "proactive",
    triggerInstructions: answer,
  };
}

function requiredAnswer(answers: ReadonlyMap<number, readonly string[]>, index: number): string {
  return requiredAnswers(answers, index)[0] as string;
}

function requiredAnswers(
  answers: ReadonlyMap<number, readonly string[]>,
  index: number,
): readonly string[] {
  const values =
    answers
      .get(index)
      ?.map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (values.length === 0) {
    throw new AgentCreationError(
      "AGENT_CREATION_INPUT_REQUIRED",
      "Subagent creation requires answers for all three questions.",
    );
  }
  return values;
}

function resolvedScopes(scopes: readonly AgentWorkspaceScope[]): readonly AgentWorkspaceScope[] {
  const uniqueScopes = new Map<string, AgentWorkspaceScope>();
  for (const scope of scopes) {
    if (!uniqueScopes.has(scope.path)) {
      uniqueScopes.set(scope.path, scope);
    }
  }
  const workspaceScope = {
    description: "覆盖当前 workspace 的全部代码与文档",
    label: "整个工作区",
    path: ".",
  };
  const values = [...uniqueScopes.values()];
  if (!values.some((scope) => scope.path === ".")) {
    return Object.freeze([...values.slice(0, 3), workspaceScope]);
  }
  return Object.freeze(values.slice(0, 4));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}
