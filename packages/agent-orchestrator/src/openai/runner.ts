import { MaxTurnsExceededError, Runner, type RunStreamEvent, type Usage } from "@openai/agents";
import { getToolOutputTraceDetails, getToolTraceDetails, type ToolEffect } from "@yiku/agent-code";
import { PROMPT_TRUST_POLICY } from "../prompt/context.js";
import { protectModelInputItems } from "../prompt/tool-output.js";
import type {
  AgentProgressEvent,
  AgentRunner,
  AgentRunResult,
  AgentRuntimeIdentity,
  AgentUsage,
  CreateOpenAIAgentRunnerOptions,
  OpenAIAgent,
  RunnerAdapter,
} from "../runtime/types.js";
import { CompatibleOpenAIProvider } from "./responses-compatibility.js";
import { disableOpenAISdkTracing } from "./tracing.js";

disableOpenAISdkTracing();

const DEFAULT_MAX_TURNS = 100;

interface StreamState {
  previousAgentName?: string | undefined;
  readonly toolEffects: Map<string, ToolEffect>;
}

type AgentIdentityResolver = (agent: OpenAIAgent) => AgentRuntimeIdentity | undefined;

export function createOpenAIAgentRunner(options: CreateOpenAIAgentRunnerOptions = {}): AgentRunner {
  const createRunner = options.createRunner ?? createOpenAIRunnerAdapter;

  return async (input) => {
    const runner = createRunner(input.apiKey, input.baseURL);
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;

    if (input.onEvent === undefined) {
      try {
        const result = await runner.run(input.agent, input.continuationState ?? input.prompt, {
          callModelInputFilter: async ({ modelData }) => {
            await input.beforeModelCall?.();
            return {
              ...modelData,
              input: protectModelInputItems(modelData.input),
              instructions: withPromptTrustPolicy(modelData.instructions),
            };
          },
          maxTurns,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const usage = getResultUsage(result);

        return {
          finalOutput: result.finalOutput,
          stopReason: "completed",
          ...(usage !== undefined ? { usage } : {}),
        };
      } catch (error) {
        const stopped = stoppedResult(error, input.signal);
        if (stopped !== undefined) {
          return stopped;
        }
        throw error;
      }
    }

    let result: Awaited<ReturnType<RunnerAdapter["run"]>> | undefined;
    let completed = false;
    const streamState: StreamState = {
      toolEffects: new Map(),
    };

    try {
      result = await runner.run(input.agent, input.continuationState ?? input.prompt, {
        callModelInputFilter: async ({ modelData }) => {
          await input.beforeModelCall?.();
          return {
            ...modelData,
            input: protectModelInputItems(modelData.input),
            instructions: withPromptTrustPolicy(modelData.instructions),
          };
        },
        maxTurns,
        ...(input.signal ? { signal: input.signal } : {}),
        stream: true,
      });

      for await (const event of result) {
        for (const progressEvent of toAgentProgressEvents(
          event,
          streamState,
          input.resolveAgentIdentity,
        )) {
          input.onEvent(progressEvent);
        }
      }

      await result.completed;
      completed = true;
      const usage = getResultUsage(result);

      return {
        finalOutput: result.finalOutput,
        stopReason: "completed",
        ...(usage !== undefined ? { usage } : {}),
      };
    } catch (error) {
      const stopped = stoppedResult(error, input.signal);
      if (stopped !== undefined) {
        return stopped;
      }
      throw error;
    } finally {
      const usage = result === undefined ? undefined : getResultUsage(result);

      if (!completed && usage !== undefined) {
        input.onEvent({
          model: input.model,
          type: "usage_updated",
          usage,
        });
      }
    }
  };
}

function withPromptTrustPolicy(instructions: string | undefined): string {
  const normalized = instructions?.trim();
  if (!normalized) {
    return PROMPT_TRUST_POLICY;
  }
  return normalized.includes(PROMPT_TRUST_POLICY)
    ? normalized
    : `${normalized}\n\n${PROMPT_TRUST_POLICY}`;
}

function stoppedResult(
  error: unknown,
  signal: AbortSignal | undefined,
): AgentRunResult | undefined {
  if (error instanceof MaxTurnsExceededError && error.state !== undefined) {
    return {
      continuationState: error.state,
      stopReason: "max_turns",
    };
  }
  if (signal?.aborted) {
    return {
      stopReason:
        signal.reason instanceof Error && signal.reason.name === "StageTimeoutError"
          ? "timeout"
          : "cancelled",
    };
  }
  return undefined;
}

export function getResultUsage(result: unknown): AgentUsage | undefined {
  const resultRecord = asRecord(result);
  const runContext = asRecord(resultRecord?.runContext);
  const usage = runContext?.usage;

  return isUsage(usage) ? toAgentUsage(usage) : undefined;
}

function isUsage(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.totalTokens === "number"
  );
}

function toAgentUsage(usage: Usage): AgentUsage {
  const requestEntries = usage.requestUsageEntries ?? [];
  const inputDetails =
    requestEntries.length > 0
      ? requestEntries.map((entry) => entry.inputTokensDetails)
      : usage.inputTokensDetails;

  return {
    cachedInputTokens: sumDetail(inputDetails, "cached_tokens"),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    peakInputTokens:
      requestEntries.length > 0
        ? Math.max(0, ...requestEntries.map((entry) => entry.inputTokens))
        : usage.inputTokens,
    totalTokens: usage.totalTokens,
  };
}

function sumDetail(details: readonly Record<string, number>[], key: string): number {
  return details.reduce((total, detail) => total + (detail[key] ?? 0), 0);
}

function toAgentProgressEvents(
  event: RunStreamEvent,
  state: StreamState,
  resolveAgentIdentity: AgentIdentityResolver | undefined,
): readonly AgentProgressEvent[] {
  if (event.type === "agent_updated_stream_event") {
    const agentName = event.agent.name;
    const identity = resolveAgentIdentity?.(event.agent);
    const events: AgentProgressEvent[] = [];

    if (state.previousAgentName !== undefined && state.previousAgentName !== agentName) {
      events.push({
        sourceAgentName: state.previousAgentName,
        targetAgentName: agentName,
        type: "handoff",
      });
    }

    state.previousAgentName = agentName;
    events.push({
      ...(identity !== undefined ? { agentId: identity.agentId } : {}),
      agentName,
      type: "agent_updated",
    });

    return events;
  }

  if (event.type === "raw_model_stream_event") {
    if (event.data.type !== "output_text_delta" || event.data.delta === "") {
      return [];
    }

    return [
      {
        text: event.data.delta,
        type: "message_delta",
      },
    ];
  }

  if (event.type !== "run_item_stream_event") {
    return [];
  }

  if (event.name === "reasoning_item_created") {
    return [
      {
        type: "reasoning",
      },
    ];
  }

  if (event.name === "tool_called") {
    const toolName = getRunItemToolName(event.item);
    const input = getRunItemToolInput(event.item);
    const callId = getRunItemToolCallId(event.item);
    const effect = getToolEffect(toolName, input);
    if (callId !== undefined) {
      state.toolEffects.set(callId, effect);
    }
    const details = getToolTraceDetails(toolName, input);

    return [
      {
        ...details,
        ...(callId !== undefined ? { callId } : {}),
        effect,
        ...(input !== undefined ? { input } : {}),
        toolName,
        type: "tool_called",
      },
    ];
  }

  if (event.name === "tool_output") {
    const toolName = getRunItemToolName(event.item);
    const output = getRunItemToolOutput(event.item);
    const callId = getRunItemToolCallId(event.item);
    const effect =
      callId === undefined
        ? getToolEffect(toolName)
        : (state.toolEffects.get(callId) ?? getToolEffect(toolName));
    if (callId !== undefined) {
      state.toolEffects.delete(callId);
    }
    const details = getToolOutputTraceDetails(toolName, output);

    return [
      {
        ...details,
        ...(callId !== undefined ? { callId } : {}),
        effect,
        ...(output !== undefined ? { output } : {}),
        toolName,
        type: "tool_output",
      },
    ];
  }

  return [];
}

function getRunItemToolName(item: { readonly rawItem?: unknown }): string {
  const rawItem = item.rawItem;

  if (typeof rawItem !== "object" || rawItem === null || !("name" in rawItem)) {
    return "unknown";
  }

  const name = (rawItem as { readonly name?: unknown }).name;

  return typeof name === "string" && name.trim() ? name : "unknown";
}

function getRunItemToolCallId(item: { readonly rawItem?: unknown }): string | undefined {
  const rawItem = asRecord(item.rawItem);
  const callId = firstDefined(rawItem?.callId, rawItem?.call_id);

  return typeof callId === "string" && callId.trim() ? callId : undefined;
}

function getRunItemToolInput(item: { readonly rawItem?: unknown }): unknown {
  const rawItem = asRecord(item.rawItem);

  if (rawItem === undefined) {
    return undefined;
  }

  return parseRawPayload(
    firstDefined(rawItem.arguments, rawItem.input, rawItem.parameters, rawItem.params),
  );
}

function getRunItemToolOutput(item: { readonly rawItem?: unknown }): unknown {
  const rawItem = asRecord(item.rawItem);

  if (rawItem === undefined) {
    return undefined;
  }

  return unwrapTextContent(
    parseRawPayload(firstDefined(rawItem.output, rawItem.result, rawItem.content)),
  );
}

function firstDefined(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function parseRawPayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unwrapTextContent(value: unknown): unknown {
  const directText = readTextContent(value);

  if (directText !== undefined) {
    return directText;
  }

  if (!Array.isArray(value) || value.length === 0) {
    return value;
  }

  const textParts = value.map((item) => readTextContent(item));

  return textParts.every((text) => text !== undefined) ? textParts.join("\n") : value;
}

function readTextContent(value: unknown): string | undefined {
  const record = asRecord(value);

  return record?.type === "text" && typeof record.text === "string" ? record.text : undefined;
}

function getToolEffect(toolName: string, input?: unknown): ToolEffect {
  switch (toolName) {
    case "grepTool":
    case "lsTool":
    case "treeTool":
      return "read";
    case "bashTool":
      return "process";
    case "todoWriteTool":
      return "write";
    case "textEditorTool":
      return asRecord(input)?.command === "view" ? "read" : "write";
    default:
      return "external";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/* v8 ignore next 8 */
function createOpenAIRunnerAdapter(apiKey: string, baseURL?: string | undefined): RunnerAdapter {
  return new Runner({
    modelProvider: new CompatibleOpenAIProvider({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    }),
    tracingDisabled: true,
  });
}
