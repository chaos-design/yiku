import { Agent, type Tool } from "@openai/agents";
import { requireNonEmpty } from "../tools/common/validation.js";

export type OpenAIAgent = Agent;

export interface CodeAgentOptions {
  readonly agentName: string;
  readonly handoffs?: readonly Agent[] | undefined;
  readonly instructions?: string | undefined;
  readonly model: string;
  readonly tools?: readonly Tool[] | undefined;
}

export class CodeAgent extends Agent {
  public constructor(options: CodeAgentOptions) {
    const instructions = options.instructions?.trim();

    super({
      ...(options.handoffs ? { handoffs: [...options.handoffs] } : {}),
      ...(instructions ? { instructions } : {}),
      model: requireNonEmpty(options.model, "Model is required."),
      name: requireNonEmpty(options.agentName, "Agent name is required."),
      ...(options.tools ? { tools: [...options.tools] } : {}),
    });
  }
}
