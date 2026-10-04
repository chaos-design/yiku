import { CodeAgent } from "@yiku/agent-code";
import type { AgentRunner } from "../runtime/types.js";
import {
  type AgentProfileDraft,
  type AgentProfileGenerationInput,
  type AgentProfileGenerator,
  parseAgentProfileDraft,
} from "../session/agent-profile.js";
import { createOpenAIAgentRunner } from "./runner.js";

const GENERATOR_INSTRUCTIONS = [
  "Generate one reusable coding subagent profile from the supplied requirements.",
  "Return only a JSON object with these fields:",
  "name, description, purpose, scopes, invocationMode, triggerInstructions when applicable,",
  "agentType, modelKey, accessMode, skillNames, role, deliverable, instructions.",
  "Use only the supplied agent types, models, skills, and access modes.",
  "Preserve user-selected purpose, scopes, invocation mode, and trigger instructions exactly.",
  "The name must be concise lowercase kebab-case.",
  "Do not include markdown fences or explanatory text.",
].join(" ");

export interface OpenAIAgentProfileGeneratorOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly model: string;
  readonly runner?: AgentRunner | undefined;
}

export class OpenAIAgentProfileGenerator implements AgentProfileGenerator {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAIAgentProfileGeneratorOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async generate(
    input: AgentProfileGenerationInput,
    options: {
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<AgentProfileDraft> {
    const result = await this.runner({
      agent: new CodeAgent({
        agentName: "Yiku Agent Profile Generator",
        instructions: GENERATOR_INSTRUCTIONS,
        model: this.options.model,
        tools: [],
      }),
      apiKey: this.options.apiKey,
      ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
      maxTurns: 1,
      model: this.options.model,
      prompt: buildPrompt(input),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if ((result.stopReason ?? "completed") !== "completed") {
      throw new Error(`Agent Profile generation did not complete: ${result.stopReason}.`);
    }
    return parseAgentProfileDraft(parseOutput(result.finalOutput), input);
  }
}

function buildPrompt(input: AgentProfileGenerationInput): string {
  return JSON.stringify(
    {
      constraints: {
        agentTypes: input.agentTypes,
        currentModelKey: input.currentModelKey,
        modelKeys: input.modelKeys,
        parentAccessMode: input.parentAccessMode,
        scopes: input.availableScopes,
        skills: input.skills.map((skill) => ({
          agentTypes: skill.agentTypes,
          description: skill.description,
          name: skill.name,
        })),
      },
      requirements: input.requirements,
    },
    null,
    2,
  );
}

function parseOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  const text = output.trim();
  const json = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : text;
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error("Agent Profile generator must return valid JSON.", { cause: error });
  }
}
