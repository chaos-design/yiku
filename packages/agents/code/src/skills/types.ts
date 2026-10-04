import type { Tool } from "@openai/agents";

export interface CodeSkill {
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly name: "code";
  readonly tools: readonly Tool[];
}
