import type { Agent, Tool } from "@openai/agents";
import type { PermissionApprovalHandler } from "@yiku/agent-code";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import type { AgentArtifactRef, EvalCheckEvaluator, ResearchClaimManifest } from "@yiku/evals";
import type {
  AgentProgressEvent,
  AgentRuntimeIdentity,
  AgentRunValidation,
  AgentStopReason,
} from "../runtime/types.js";
import type { Skill } from "../skills/types.js";

export interface AgentDefinition {
  readonly delegates?: readonly string[] | undefined;
  readonly handoffs?: readonly string[] | undefined;
  readonly hookFrontmatter?: string | undefined;
  readonly instructions?: string | undefined;
  readonly key: string;
  readonly modelKey?: string | undefined;
  readonly name: string;
  readonly skills?: readonly string[] | undefined;
  readonly type?: string | undefined;
}

export interface AgentGraph {
  readonly defaultAgentKey?: string | undefined;
  readonly items: ReadonlyMap<string, AgentDefinition>;
}

export interface CreateAgentOptions {
  readonly agentName: string;
  readonly handoffs?: readonly Agent[] | undefined;
  readonly instructions?: string | undefined;
  readonly model: string;
  readonly permissionApprovalHandler?: PermissionApprovalHandler | undefined;
  readonly skills?: readonly Skill[] | undefined;
  readonly workspaceDir: string;
}

export interface AgentModule {
  readonly createAgent: (options: CreateAgentOptions) => Agent;
  readonly key: string;
  readonly skills?: readonly Skill[] | undefined;
}

export interface AgentFactoryInput {
  readonly agentName: string;
  readonly handoffs: readonly Agent[];
  readonly instructions?: string | undefined;
  readonly model: string;
  readonly tools: readonly Tool[];
  readonly workspaceDir: string;
}

export interface AgentFactoryResult {
  readonly agent: Agent;
  readonly close?: (() => Promise<void> | void) | undefined;
  readonly createRunObserver?: AgentRunObserverFactory | undefined;
  readonly evaluationProvider?: AgentEvaluationProvider | undefined;
  readonly validateOutput?: AgentOutputValidator | undefined;
}

export interface AgentEvaluationData {
  readonly artifacts: readonly AgentArtifactRef[];
  readonly researchClaimManifest?: ResearchClaimManifest | undefined;
}

export interface AgentEvaluationProvider {
  createEvaluators(config?: Readonly<Record<string, unknown>>): readonly EvalCheckEvaluator[];
  snapshot(finalOutput: string): AgentEvaluationData;
}

export interface AgentFactory<TResult extends AgentFactoryResult = AgentFactoryResult> {
  readonly type: string;
  create(input: AgentFactoryInput): TResult;
}

export type AgentOutputValidator = (
  output: unknown,
) => AgentRunValidation | Promise<AgentRunValidation>;

export interface AgentObservabilityContext extends AgentRuntimeIdentity {
  readonly atomicFlow: AtomicFlowRun;
  readonly parentInstanceId: string;
  readonly prompt: string;
  readonly runId: string;
}

export interface AgentRunObserver {
  close(): Promise<void> | void;
  error(cause: unknown): void;
  output(output: unknown): AgentRunValidation | undefined | Promise<AgentRunValidation | undefined>;
  progress(event: AgentProgressEvent): void;
  start(): void;
  stop(reason: AgentStopReason): void;
}

export type AgentRunObserverFactory = (context: AgentObservabilityContext) => AgentRunObserver;
