import { Agent, type Tool } from "@openai/agents";
import { DEFAULT_RESEARCH_PROMPT } from "../prompts/index.js";
import {
  createResearchWebSearchTool,
  type SearchContextSize as WebSearchContextSize,
} from "../tools/web-search-tool.js";

export type SearchContextSize = WebSearchContextSize;

export interface ResearchAgentOptions {
  readonly agentName: string;
  readonly handoffs?: readonly Agent[] | undefined;
  readonly instructions?: string | undefined;
  readonly model: string;
  readonly searchContextSize?: SearchContextSize | undefined;
  readonly tools?: readonly Tool[] | undefined;
}

export class ResearchAgent extends Agent {
  public constructor(options: ResearchAgentOptions) {
    super({
      ...(options.handoffs !== undefined ? { handoffs: [...options.handoffs] } : {}),
      instructions: options.instructions?.trim() || DEFAULT_RESEARCH_PROMPT,
      model: requireNonEmpty(options.model, "Model is required."),
      name: requireNonEmpty(options.agentName, "Agent name is required."),
      tools:
        options.tools === undefined
          ? [createResearchWebSearchTool(options.searchContextSize)]
          : [...options.tools],
    });
  }
}

function requireNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(message);
  }

  return trimmed;
}
