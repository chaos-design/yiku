import { CodeAgent } from "@yiku/agent-code";
import type { AgentRunner } from "../runtime/types.js";
import type { ContextSummarizer, ContextSummaryInput } from "../session/compactor.js";
import { createOpenAIAgentRunner } from "./runner.js";

const SUMMARIZER_INSTRUCTIONS = [
  "Summarize the supplied conversation for a coding agent that will continue the task.",
  "Preserve decisions, constraints, completed work, unresolved tasks, file paths, commands, and errors.",
  "Do not invent facts. Return only the summary text.",
].join(" ");

export interface OpenAIContextSummarizerOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly model: string;
  readonly runner?: AgentRunner | undefined;
}

export class OpenAIContextSummarizer implements ContextSummarizer {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAIContextSummarizerOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async summarize(input: ContextSummaryInput): Promise<string> {
    const result = await this.runner({
      agent: new CodeAgent({
        agentName: "Yiku Context Summarizer",
        instructions: SUMMARIZER_INSTRUCTIONS,
        model: this.options.model,
        tools: [],
      }),
      apiKey: this.options.apiKey,
      ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
      maxTurns: 1,
      model: this.options.model,
      prompt: buildPrompt(input),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    if ((result.stopReason ?? "completed") !== "completed") {
      throw new Error(`Context summarization did not complete: ${result.stopReason}.`);
    }
    if (typeof result.finalOutput !== "string") {
      throw new Error("Context summarizer must return text output.");
    }
    return result.finalOutput.trim();
  }
}

function buildPrompt(input: ContextSummaryInput): string {
  return [
    `Maximum summary length: ${input.maxChars} characters.`,
    input.customInstructions ? `Additional summary instructions:\n${input.customInstructions}` : "",
    "Conversation entries:",
    JSON.stringify(input.entries),
  ]
    .filter(Boolean)
    .join("\n\n");
}
