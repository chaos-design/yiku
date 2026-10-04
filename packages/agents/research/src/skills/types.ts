import type { Tool } from "@openai/agents";

export interface ResearchSkill {
  readonly description: string;
  readonly instructions: string;
  readonly name: "research";
  readonly tools: readonly Tool[];
}
