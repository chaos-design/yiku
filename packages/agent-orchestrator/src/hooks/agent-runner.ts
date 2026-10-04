import type { Tool } from "@openai/agents";
import { CodeAgent } from "@yiku/agent-code";
import {
  type HookAgentRunInput,
  type HookAgentRunner,
  HookError,
  HookExecutionError,
  type HookHandlerOutput,
  HookProtocolError,
} from "@yiku/hooks";
import { createOpenAIAgentRunner } from "../openai/runner.js";
import type { AgentRunner } from "../runtime/types.js";
import { parseHookRunnerOutput } from "./model-runner.js";

const AGENT_HOOK_INSTRUCTIONS = [
  "Inspect the task using only the provided tools and evaluate the Hook event.",
  "Return only one JSON object compatible with the Hook output protocol.",
  "Do not include markdown fences or explanatory text.",
].join(" ");

export interface OpenAIHookAgentRunnerOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly defaultModel: string;
  readonly runner?: AgentRunner | undefined;
  readonly tools?: readonly Tool[] | undefined;
}

export class OpenAIHookAgentRunner implements HookAgentRunner {
  private readonly runner: AgentRunner;

  public constructor(private readonly options: OpenAIHookAgentRunnerOptions) {
    this.runner = options.runner ?? createOpenAIAgentRunner();
  }

  public async run(input: HookAgentRunInput): Promise<HookHandlerOutput> {
    const model = input.model ?? this.options.defaultModel;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (input.signal?.aborted === true) {
      abortFromParent();
    }
    let toolCalls = 0;

    try {
      const result = await this.runner({
        agent: new CodeAgent({
          agentName: "Yiku Hook Agent",
          instructions: AGENT_HOOK_INSTRUCTIONS,
          model,
          tools: [...(this.options.tools ?? [])],
        }),
        apiKey: this.options.apiKey,
        ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
        maxTurns: input.maxTurns,
        model,
        onEvent: (event) => {
          if (event.type !== "tool_called") {
            return;
          }

          toolCalls += 1;
          if (toolCalls > input.maxToolCalls) {
            controller.abort(
              new HookExecutionError(
                "HOOK_EXECUTION_FAILED",
                "Hook Agent tool-call budget exceeded.",
                { executorType: "agent" },
              ),
            );
          }
        },
        prompt: input.prompt,
        signal: controller.signal,
      });

      if (result.usage !== undefined && result.usage.totalTokens > input.maxTokens) {
        throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook Agent token budget exceeded.", {
          executorType: "agent",
        });
      }

      return parseHookRunnerOutput(input, result.finalOutput);
    } catch (error) {
      if (error instanceof HookError || error instanceof HookProtocolError) {
        throw error;
      }

      throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook Agent execution failed.", {
        cause: error,
        eventName: input.event.hook_event_name,
        executorType: "agent",
        retryable: true,
      });
    } finally {
      input.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}
