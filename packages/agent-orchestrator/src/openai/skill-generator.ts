import { CodeAgent } from "@yiku/agent-code";
import type { AgentRunner } from "../runtime/types.js";
import { parseSkillDraft, type SkillDraft, type SkillGenerator } from "../skills/skill-creation.js";
import { createOpenAIAgentRunner } from "./runner.js";

const GENERATOR_INSTRUCTIONS = [
  "Generate one reusable coding Skill from the supplied natural-language intent.",
  "Return only a JSON object with exactly these fields: name, description, instructions.",
  "The name must be concise lowercase kebab-case with at most 64 characters.",
  "The description must state what the Skill does and when to invoke it in at most 200 characters.",
  "The instructions must give concrete workflow, constraints, stopping conditions, and output format.",
  "Do not add MCP capabilities, metadata, markdown fences, or explanatory text.",
].join(" ");

export interface OpenAISkillGeneratorOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly model: string;
  readonly runner?: AgentRunner | undefined;
}

export class OpenAISkillGenerator implements SkillGenerator {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAISkillGeneratorOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async generate(
    intent: string,
    options: {
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<SkillDraft> {
    const result = await this.runner({
      agent: new CodeAgent({
        agentName: "Yiku Skill Generator",
        instructions: GENERATOR_INSTRUCTIONS,
        model: this.options.model,
        tools: [],
      }),
      apiKey: this.options.apiKey,
      ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
      maxTurns: 1,
      model: this.options.model,
      prompt: JSON.stringify({ intent: intent.trim() }, null, 2),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if ((result.stopReason ?? "completed") !== "completed") {
      throw new Error(`Skill generation did not complete: ${result.stopReason}.`);
    }
    return parseSkillDraft(parseOutput(result.finalOutput));
  }
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
    throw new Error("Skill generator must return valid JSON.", { cause: error });
  }
}
