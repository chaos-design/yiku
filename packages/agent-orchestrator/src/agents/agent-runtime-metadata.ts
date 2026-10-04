import type { Agent } from "@openai/agents";
import type { AgentRuntimeIdentity, OpenAIAgent } from "../runtime/types.js";
import { requireText } from "../validation.js";
import type {
  AgentEvaluationProvider,
  AgentFactory,
  AgentFactoryInput,
  AgentFactoryResult,
  AgentOutputValidator,
  AgentRunObserverFactory,
} from "./types.js";

export interface RegisteredAgentIdentity {
  readonly agentId: string;
  readonly agentKey?: string | undefined;
  readonly agentType: string;
}

export interface AgentRuntimeMetadata {
  readonly createRunObserver?: AgentRunObserverFactory | undefined;
  readonly evaluationProvider?: AgentEvaluationProvider | undefined;
  readonly identity: AgentRuntimeIdentity;
  readonly validateOutput?: AgentOutputValidator | undefined;
}

const AGENT_METADATA = new WeakMap<Agent, AgentRuntimeMetadata>();
const AGENT_GRAPHS = new WeakMap<Agent, readonly Agent[]>();

export function createRegisteredAgent<TResult extends AgentFactoryResult>(
  factory: AgentFactory<TResult>,
  input: AgentFactoryInput,
  identity: RegisteredAgentIdentity,
): TResult {
  const result = factory.create(input);
  registerAgentFactoryResult(result, identity);
  return result;
}

export function registerAgentFactoryResult(
  result: AgentFactoryResult,
  identity: RegisteredAgentIdentity,
): void {
  AGENT_METADATA.set(result.agent, {
    ...(result.createRunObserver !== undefined
      ? { createRunObserver: result.createRunObserver }
      : {}),
    ...(result.evaluationProvider !== undefined
      ? { evaluationProvider: result.evaluationProvider }
      : {}),
    identity: {
      agentId: requireText(identity.agentId, "Agent runtime ID"),
      ...(identity.agentKey !== undefined
        ? { agentKey: requireText(identity.agentKey, "Agent key") }
        : {}),
      agentName: requireText(result.agent.name, "Agent name"),
      agentType: requireText(identity.agentType, "Agent type"),
    },
    ...(result.validateOutput !== undefined ? { validateOutput: result.validateOutput } : {}),
  });
}

export function registerAgentGraph(root: Agent, members: readonly Agent[]): void {
  AGENT_GRAPHS.set(root, Object.freeze([root, ...members.filter((member) => member !== root)]));
}

export function getAgentRuntimeMetadata(agent: Agent): AgentRuntimeMetadata | undefined {
  return AGENT_METADATA.get(agent);
}

export function getAgentGraphMembers(root: Agent): readonly Agent[] {
  return AGENT_GRAPHS.get(root) ?? [root];
}

export function inheritAgentRuntimeMetadata(source: Agent, target: Agent): void {
  const metadata = AGENT_METADATA.get(source);
  if (metadata !== undefined) {
    AGENT_METADATA.set(target, metadata);
  }
  const graph = AGENT_GRAPHS.get(source);
  if (graph !== undefined) {
    AGENT_GRAPHS.set(
      target,
      Object.freeze([target, ...graph.filter((member) => member !== source)]),
    );
  }
}

export function createAgentIdentityResolver(
  root: Agent,
  runId: string,
): (agent: OpenAIAgent) => AgentRuntimeIdentity {
  const normalizedRunId = requireText(runId, "Run ID");
  const fallbacks = new WeakMap<object, AgentRuntimeIdentity>();
  let fallbackSequence = 0;
  if (AGENT_METADATA.get(root) === undefined) {
    fallbacks.set(root, fallbackIdentity(root, normalizedRunId, fallbackSequence));
  }

  return (agent) => {
    if (isAgent(agent)) {
      const metadata = AGENT_METADATA.get(agent);
      if (metadata !== undefined) {
        return metadata.identity;
      }
    }

    if (typeof agent === "object" && agent !== null) {
      const existing = fallbacks.get(agent);
      if (existing !== undefined) {
        return existing;
      }
      fallbackSequence += 1;
      const identity = fallbackIdentity(agent, normalizedRunId, fallbackSequence);
      fallbacks.set(agent, identity);
      return identity;
    }

    fallbackSequence += 1;
    return fallbackIdentity(agent, normalizedRunId, fallbackSequence);
  };
}

function fallbackIdentity(
  agent: OpenAIAgent,
  runId: string,
  sequence: number,
): AgentRuntimeIdentity {
  const name =
    typeof agent === "object" &&
    agent !== null &&
    "name" in agent &&
    typeof agent.name === "string" &&
    agent.name.trim()
      ? agent.name.trim()
      : "Agent";
  return {
    agentId: `${runId}:agent-${sequence}`,
    agentName: name,
    agentType: "custom",
  };
}

function isAgent(value: OpenAIAgent): value is Agent {
  return typeof value === "object" && value !== null;
}
