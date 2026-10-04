import { CodeAgent } from "@yiku/agent-code";
import {
  HookExecutionError,
  type HookHandlerOutput,
  type HookModelRunInput,
  type HookModelRunner,
  HookProtocolError,
  parseHookHandlerOutput,
} from "@yiku/hooks";
import { createOpenAIAgentRunner } from "../openai/runner.js";
import type { AgentRunner } from "../runtime/types.js";

const MODEL_HOOK_INSTRUCTIONS = [
  "Evaluate the Hook event according to the supplied prompt.",
  "Return only one JSON object compatible with the Hook output protocol.",
  "Do not include markdown fences or explanatory text.",
].join(" ");

export interface OpenAIHookModelRunnerOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly defaultModel: string;
  readonly runner?: AgentRunner | undefined;
}

export class OpenAIHookModelRunner implements HookModelRunner {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAIHookModelRunnerOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async run(input: HookModelRunInput): Promise<HookHandlerOutput> {
    const model = input.model ?? this.options.defaultModel;

    try {
      const result = await this.runner({
        agent: new CodeAgent({
          agentName: "Yiku Hook Evaluator",
          instructions: MODEL_HOOK_INSTRUCTIONS,
          model,
          tools: [],
        }),
        apiKey: this.options.apiKey,
        ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
        maxTurns: 1,
        model,
        prompt: input.prompt,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      return parseHookRunnerOutput(input, result.finalOutput);
    } catch (error) {
      if (error instanceof HookProtocolError) {
        throw error;
      }

      throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook model evaluation failed.", {
        cause: error,
        eventName: input.event.hook_event_name,
        executorType: "prompt",
        retryable: true,
      });
    }
  }
}

export function parseHookRunnerOutput(
  input: Pick<HookModelRunInput, "event" | "maxOutputBytes">,
  output: unknown,
): HookHandlerOutput {
  const value = parseOutputValue(output, input.maxOutputBytes);
  return parseHookHandlerOutput(input.event.hook_event_name, value);
}

function parseOutputValue(output: unknown, maxOutputBytes: number): unknown {
  if (typeof output === "string") {
    if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
      throw new HookProtocolError(
        "HOOK_PROTOCOL_INVALID",
        "Hook runner output exceeds the configured byte limit.",
      );
    }

    try {
      return JSON.parse(output);
    } catch (error) {
      throw new HookProtocolError(
        "HOOK_PROTOCOL_INVALID",
        "Hook runner output is not valid JSON.",
        { cause: error },
      );
    }
  }

  const serialized = JSON.stringify(output);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxOutputBytes) {
    throw new HookProtocolError(
      "HOOK_PROTOCOL_INVALID",
      "Hook runner output is not a bounded JSON object.",
    );
  }

  return output;
}
