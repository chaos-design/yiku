import { randomUUID } from "node:crypto";
import { type Agent, user } from "@openai/agents";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import type { OperationEvent } from "@yiku/trajectory";
import { projectTrajectory } from "@yiku/trajectory";
import {
  createAgentIdentityResolver,
  inheritAgentRuntimeMetadata,
} from "../agents/agent-runtime-metadata.js";
import { createAgentGraphRunObserver } from "../agents/run-observer.js";
import { OperationHookAdapter } from "../hooks/operation-adapter.js";
import { createOpenAIAgentRunner } from "../openai/runner.js";
import {
  latestUserPrompt,
  promptInputCharacterCount,
  renderPromptReference,
} from "../prompt/context.js";
import { AtomicRuntime } from "./atomic-runtime.js";
import { RUNTIME_ATOMS } from "./atoms.js";
import type {
  AgentProgressEvent,
  AgentRunResult,
  AgentRunValidation,
  AgentUsage,
  OpenAIAgent,
  RunInput,
  RunOptions,
} from "./types.js";

export const DEFAULT_MAX_TURNS = 100;

interface OperationState {
  readonly runId: string;
  readonly toolOperations: Map<string, string>;
}

export async function run(
  agent: OpenAIAgent,
  input: RunInput,
  options: RunOptions,
): Promise<AgentRunResult> {
  const runner = options.runner ?? createOpenAIAgentRunner();
  const executionAgent = resolveRunAgent(agent, options);
  const executionInput = resolveRunInput(input, options);
  const atomicFlow = options.atomicFlow ?? new AtomicFlowRun({ runId: randomUUID() });
  const ownsAtomicFlow = options.atomicFlow === undefined;
  const runtimeAgent = agent as Agent;
  if (executionAgent !== agent) {
    inheritAgentRuntimeMetadata(runtimeAgent, executionAgent as Agent);
  }
  const resolveAgentIdentity = createAgentIdentityResolver(runtimeAgent, atomicFlow.runId);
  const operationState: OperationState = {
    runId: atomicFlow.runId,
    toolOperations: new Map(),
  };
  const existingEvents = atomicFlow.snapshot().events;
  let entryEvent =
    options.atomicEntryInstanceId === undefined
      ? existingEvents.findLast(
          (event) =>
            event.atom.key === "memory.context-inject" ||
            event.atom.key === RUNTIME_ATOMS.inputPrompt.key,
        )
      : existingEvents.findLast(
          (event) =>
            event.instance.id === options.atomicEntryInstanceId &&
            (event.phase === "end" || event.phase === "start"),
        );
  if (options.atomicEntryInstanceId !== undefined && entryEvent === undefined) {
    throw new Error(`Atomic entry instance not found: ${options.atomicEntryInstanceId}.`);
  }
  if (entryEvent === undefined) {
    const inputSpan = atomicFlow.start({
      atom: RUNTIME_ATOMS.inputPrompt,
      payload: {
        counts: {
          characters: promptInputCharacterCount(executionInput),
        },
      },
    });
    entryEvent = inputSpan.end();
  }
  const runSpan = atomicFlow.start({
    atom: RUNTIME_ATOMS.run,
    edge: {
      fromAtomKey: entryEvent.atom.key,
      kind: "execution",
      toAtomKey: RUNTIME_ATOMS.run.key,
    },
    instanceId: `run-${atomicFlow.runId}-${randomUUID()}`,
    parentInstanceId: entryEvent.instance.id,
  });
  const atomicRuntime = new AtomicRuntime(atomicFlow, runSpan.instanceId);
  const runObserver = createAgentGraphRunObserver(runtimeAgent, {
    atomicFlow,
    parentInstanceId: runSpan.instanceId,
    prompt: latestUserPrompt(executionInput),
    runId: atomicFlow.runId,
  });
  const hooks = [
    ...(options.hooks ?? []),
    ...(options.skills ?? []).flatMap((skill) => skill.hooks ?? []),
  ];
  const operationHooks = new OperationHookAdapter(hooks);

  runObserver.start();
  emitOperation({
    adapter: operationHooks,
    event: createOperationEvent({
      kind: "run",
      name: "run",
      operationId: operationState.runId,
      phase: "start",
      status: "running",
    }),
  });
  await operationHooks.flush();

  try {
    const result = await runner({
      agent: executionAgent,
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.beforeModelCall !== undefined
        ? { beforeModelCall: options.beforeModelCall }
        : {}),
      ...(options.continuationState !== undefined
        ? { continuationState: options.continuationState }
        : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      model: options.model,
      onEvent: (event) => {
        atomicRuntime.record(event);
        runObserver.progress(event);
        options.onEvent?.(event);
        const operationEvent = toOperationEvent(event, operationState);

        if (operationEvent !== undefined) {
          emitOperation({
            adapter: operationHooks,
            event: operationEvent,
          });
        }
      },
      prompt: executionInput,
      resolveAgentIdentity,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await operationHooks.flush();
    const stopReason = result.stopReason ?? "completed";
    let outputValidation: AgentRunValidation | undefined;
    if (stopReason === "completed") {
      atomicRuntime.complete(result.finalOutput);
      outputValidation = await runObserver.output(result.finalOutput);
    } else {
      atomicRuntime.stop(stopReason);
      runObserver.stop(stopReason);
    }

    const validationFailed = outputValidation?.passed === false;
    const validationSummary =
      outputValidation?.diagnostics.join("; ") || "Agent output validation failed.";
    emitOperation({
      adapter: operationHooks,
      event: createOperationEvent({
        endedAt: new Date().toISOString(),
        ...(validationFailed
          ? {
              error: validationSummary,
            }
          : {}),
        kind: "run",
        name: "run",
        operationId: operationState.runId,
        output: stopReason === "completed" ? result.finalOutput : { stopReason },
        phase: validationFailed ? "error" : "end",
        status: validationFailed ? "failed" : "completed",
      }),
    });
    await operationHooks.flush();
    if (stopReason === "cancelled") {
      runSpan.fail({
        code: "AGENT_RUN_CANCELLED",
        summary: abortReason(options.signal),
      });
    } else if (validationFailed) {
      runSpan.fail({
        code: "AGENT_OUTPUT_VALIDATION_FAILED",
        summary: validationSummary,
      });
    } else {
      runSpan.end({ summary: stopReason });
    }

    await runObserver.close();
    await atomicFlow.flush();
    const atomicSnapshot = atomicFlow.snapshot();
    const runResult = {
      atomicFlow: atomicSnapshot,
      ...(result.continuationState !== undefined
        ? { continuationState: result.continuationState }
        : {}),
      ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
      ...(outputValidation !== undefined ? { outputValidation } : {}),
      stopReason,
      trajectory: projectTrajectory(atomicSnapshot.events, {
        runId: atomicSnapshot.runId,
      }),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
    if (ownsAtomicFlow) {
      await atomicFlow.close();
    }
    return runResult;
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    const failureCode = cancelled ? "AGENT_RUN_CANCELLED" : "AGENT_RUN_FAILED";
    const failure = cancelled ? abortReason(options.signal) : getErrorMessage(error);
    runObserver.error(error);
    atomicRuntime.fail(failure, failureCode);
    runSpan.fail({
      code: failureCode,
      summary: failure,
    });
    emitOperation({
      adapter: operationHooks,
      event: createOperationEvent({
        endedAt: new Date().toISOString(),
        error: failure,
        kind: "run",
        name: "run",
        operationId: operationState.runId,
        phase: "error",
        status: "failed",
      }),
    });
    await operationHooks.flush();

    await runObserver.close();
    await atomicFlow.flush();
    if (ownsAtomicFlow) {
      await atomicFlow.close();
    }
    throw error;
  }
}
function emitOperation(input: {
  readonly adapter: OperationHookAdapter;
  readonly event: OperationEvent;
}): void {
  input.adapter.enqueue(input.event);
}

function toOperationEvent(
  event: AgentProgressEvent,
  state: OperationState,
): OperationEvent | undefined {
  switch (event.type) {
    case "agent_updated":
      return createOperationEvent({
        kind: "agent",
        name: event.agentName,
        operationId: randomUUID(),
        parentId: state.runId,
        phase: "start",
        status: "running",
      });
    case "handoff":
      return createOperationEvent({
        input: event.sourceAgentName,
        kind: "handoff",
        name: event.targetAgentName,
        operationId: randomUUID(),
        output: event.targetAgentName,
        parentId: state.runId,
        phase: "end",
        status: "completed",
      });
    case "message_delta":
      return createOperationEvent({
        kind: "model",
        name: "message_delta",
        operationId: randomUUID(),
        output: event.text,
        parentId: state.runId,
        phase: "delta",
        status: "running",
      });
    case "reasoning":
      return createOperationEvent({
        kind: "model",
        name: "reasoning",
        operationId: randomUUID(),
        parentId: state.runId,
        phase: "delta",
        status: "running",
      });
    case "tool_called": {
      const operationId = randomUUID();
      state.toolOperations.set(event.callId ?? event.toolName, operationId);

      return createOperationEvent({
        input: event.input,
        kind: "tool",
        name: event.toolName,
        operationId,
        parentId: state.runId,
        phase: "start",
        status: "running",
      });
    }
    case "tool_output": {
      const correlationKey = event.callId ?? event.toolName;
      const operationId = state.toolOperations.get(correlationKey) ?? randomUUID();
      state.toolOperations.delete(correlationKey);

      return createOperationEvent({
        endedAt: new Date().toISOString(),
        kind: "tool",
        name: event.toolName,
        operationId,
        output: event.output ?? event.summary,
        parentId: state.runId,
        phase: "end",
        status: "completed",
      });
    }
    case "usage_updated":
      return usageOperation(event.usage, state.runId);
    case "checkpoint_saved":
    case "context_compacted":
    case "evaluation_finished":
    case "agent_profile_changed":
    case "memory_operation":
    case "prompt_risk_detected":
    case "runtime_boundary_changed":
    case "session_cancelled":
    case "session_failed":
    case "session_finished":
    case "session_resumed":
    case "session_started":
    case "stage_finished":
    case "stage_started":
    case "skill_activated":
    case "skill_resolved":
    case "skill_worker_finished":
    case "skill_worker_started":
    case "subagent_output":
    case "subagent_result":
    case "subagent_spawned":
    case "task_snapshot":
    case "user_question_cancelled":
    case "user_question_requested":
    case "user_question_resolved":
      return undefined;
  }
}

function usageOperation(usage: AgentUsage, parentId: string): OperationEvent {
  return createOperationEvent({
    kind: "usage",
    name: "usage",
    operationId: randomUUID(),
    output: usage,
    parentId,
    phase: "end",
    status: "completed",
  });
}

function createOperationEvent(
  input: Omit<OperationEvent, "startedAt"> & { readonly startedAt?: string | undefined },
): OperationEvent {
  return {
    ...input,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal | undefined): string {
  return signal?.reason instanceof Error
    ? signal.reason.message
    : typeof signal?.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Agent run was cancelled.";
}

function resolveRunAgent(agent: OpenAIAgent, options: RunOptions): OpenAIAgent {
  const skillTools = (options.skills ?? []).flatMap((skill) => [...(skill.tools ?? [])]);
  const additionalTools = [...(options.tools ?? []), ...skillTools];
  const additionalInstructions = (options.skills ?? [])
    .filter((skill) => skill.source !== "project")
    .map((skill) => skill.instructions?.trim())
    .filter((instructions): instructions is string => Boolean(instructions))
    .join("\n\n");

  if (additionalTools.length === 0 && !additionalInstructions) {
    return agent;
  }

  const tools = [...agent.tools, ...additionalTools];
  assertUniqueToolNames(tools);

  return agent.clone({
    ...(additionalInstructions
      ? {
          instructions: appendAgentInstructions(agent.instructions, additionalInstructions),
        }
      : {}),
    tools,
  });
}

function resolveRunInput(input: RunInput, options: RunOptions): RunInput {
  const references = (options.skills ?? []).flatMap((skill) => {
    const instructions = skill.instructions?.trim();
    if (skill.source !== "project" || !instructions) {
      return [];
    }
    return [
      user(
        renderPromptReference({
          content: instructions,
          ...(skill.digest !== undefined ? { digest: skill.digest } : {}),
          kind: "instruction",
          source: "skill",
          sourceId: skill.name,
          trust: "untrusted",
        }),
      ),
    ];
  });
  if (references.length === 0) {
    return input;
  }
  return [...references, ...(typeof input === "string" ? [user(input)] : input)];
}

function assertUniqueToolNames(tools: RunOptions["tools"]): void {
  const names = new Set<string>();

  for (const tool of tools ?? []) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}.`);
    }
    names.add(tool.name);
  }
}

function appendAgentInstructions(
  instructions: OpenAIAgent["instructions"],
  additional: string,
): OpenAIAgent["instructions"] {
  if (typeof instructions === "string") {
    return appendText(instructions, additional);
  }

  return async (context, agent) => appendText(await instructions(context, agent), additional);
}

function appendText(base: string, additional: string): string {
  const normalizedBase = base.trim();

  return normalizedBase ? `${normalizedBase}\n\n${additional}` : additional;
}
