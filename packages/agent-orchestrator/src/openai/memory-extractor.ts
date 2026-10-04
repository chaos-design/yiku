import { CodeAgent } from "@yiku/agent-code";
import type {
  MemoryDraft,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryOperationOptions,
} from "@yiku/memories";
import { z } from "zod";
import type { AgentRunner } from "../runtime/types.js";
import { createOpenAIAgentRunner } from "./runner.js";

const EXTRACTOR_INSTRUCTIONS = [
  "Extract only durable, reusable knowledge from the supplied successful agent turn.",
  "Include stable facts, decisions, preferences, and procedures that could help future work.",
  "Do not store transient status, raw reasoning, secrets, credentials, or the complete prompt or response.",
  "Return only a JSON array with at most 20 memory drafts.",
  "Use confidence and importance numbers between 0 and 1.",
].join(" ");

const memoryDraftSchema = z
  .object({
    confidence: z.number().finite().min(0).max(1),
    content: z.string().trim().min(1),
    expiresAt: z.string().trim().min(1).optional(),
    importance: z.number().finite().min(0).max(1),
    kind: z.enum(["decision", "episode", "fact", "preference", "procedure"]),
    metadata: z.record(z.string(), z.json()).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
const memoryDraftsSchema = z.array(memoryDraftSchema).max(20);

export interface OpenAIMemoryExtractorOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly model: string;
  readonly runner?: AgentRunner | undefined;
}

export class OpenAIMemoryExtractor implements MemoryExtractor {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAIMemoryExtractorOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async extract(
    input: MemoryExtractionInput,
    options: MemoryOperationOptions = {},
  ): Promise<readonly MemoryDraft[]> {
    const result = await this.runner({
      agent: new CodeAgent({
        agentName: "Yiku Memory Extractor",
        instructions: EXTRACTOR_INSTRUCTIONS,
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
      throw new Error(`Memory extraction did not complete: ${result.stopReason}.`);
    }

    const parsed = memoryDraftsSchema.safeParse(parseOutput(result.finalOutput));
    if (!parsed.success) {
      throw new Error("Memory extractor must return at most 20 valid memory drafts.", {
        cause: parsed.error,
      });
    }
    return Object.freeze(parsed.data.map((draft) => Object.freeze(draft)));
  }
}

function buildPrompt(input: MemoryExtractionInput): string {
  return [
    "Successful agent turn:",
    JSON.stringify({
      output: input.output,
      prompt: input.prompt,
      workingMemories: input.workingMemories?.slice(-50).map((memory) => ({
        content: memory.content,
        source: memory.source,
        status: memory.status,
      })),
    }),
  ].join("\n\n");
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
    throw new Error("Memory extractor must return valid JSON.", { cause: error });
  }
}
