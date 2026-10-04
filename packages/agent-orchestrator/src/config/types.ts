import type { EnvVars, ModelsConfig } from "@yiku/config";
import type { EvalPolicyMode, EvalProfile, VerificationCommand } from "@yiku/evals";

export interface ResolveModelConfigOptions {
  readonly env: EnvVars;
  readonly modelKey?: string | undefined;
  readonly modelsConfig?: ModelsConfig | undefined;
}

export type ContextWindowSource = "configured" | "inferred";

export interface ResolvedModelConfig {
  readonly agentName: string;
  readonly apiKey: string;
  readonly apiKeyEnv: string;
  readonly baseURL?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly instructions?: string | undefined;
  readonly model: string;
  readonly modelKey: string;
}

export interface ResolveAgentGraphOptions {
  readonly modelsConfig?: ModelsConfig | undefined;
}

export interface RuntimeBudgetConfig {
  readonly autoContinue: boolean;
  readonly compactAtContextRatio: number;
  readonly compactToContextRatio: number;
  readonly maxNoProgressStages: number;
  readonly maxParallelReaders: number;
  readonly maxStageDurationMs: number;
  readonly maxStagesPerEpoch: number;
  readonly maxToolCallsPerStage: number;
  readonly maxTurnsPerStage: number;
}

export type RuntimeBudgetOverrides = Partial<RuntimeBudgetConfig>;

export interface ResolvedFlowConfig {
  readonly trace: boolean;
}

export interface ResolvedMemoryConfig {
  readonly enabled: boolean;
  readonly extraction: boolean;
  readonly failureMode: "best-effort" | "strict";
}

export interface ResolvedCodeEvalProfile {
  readonly commands: readonly VerificationCommand[];
  readonly id: string;
  readonly profile: EvalProfile;
  readonly requireChanges: boolean;
  readonly type: "code";
}

export interface ResolvedResearchEvalProfile {
  readonly freshnessDays: number;
  readonly id: string;
  readonly minimumIndependentDomains: number;
  readonly profile: EvalProfile;
  readonly type: "research";
}

export type ResolvedEvalProfile = ResolvedCodeEvalProfile | ResolvedResearchEvalProfile;

export interface ResolvedEvalConfig {
  readonly enabled: boolean;
  readonly maxConcurrentRuns: number;
  readonly mode: EvalPolicyMode;
  readonly profile?: string | undefined;
  readonly profiles: Readonly<Record<string, ResolvedEvalProfile>>;
}

interface ResolvedMcpServerConfigBase {
  readonly name: string;
  readonly tools: readonly string[];
}

export interface ResolvedStdioMcpServerConfig extends ResolvedMcpServerConfigBase {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly env: readonly string[];
  readonly transport: "stdio";
}

export interface ResolvedHttpMcpServerConfig extends ResolvedMcpServerConfigBase {
  readonly allowedEnvVars: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly transport: "streamable-http";
  readonly url: string;
}

export type ResolvedMcpServerConfig = ResolvedHttpMcpServerConfig | ResolvedStdioMcpServerConfig;

export interface ResolvedSkillConfig {
  readonly instructions?: string | undefined;
  readonly mcp: readonly string[];
  readonly name: string;
}

export interface ResolvedRuntimeConfig {
  readonly budget: RuntimeBudgetConfig;
  readonly evals: ResolvedEvalConfig;
  readonly flow: ResolvedFlowConfig;
  readonly memory: ResolvedMemoryConfig;
  readonly mcpServers: Readonly<Record<string, ResolvedMcpServerConfig>>;
  readonly modelsConfig: ModelsConfig;
  readonly skills: Readonly<Record<string, ResolvedSkillConfig>>;
}

export interface ResolveRuntimeConfigOptions {
  readonly managedDeniedCapabilities?: readonly string[] | undefined;
  readonly overrides?: RuntimeBudgetOverrides | undefined;
  readonly projectConfig?: ModelsConfig | undefined;
  readonly userConfig?: ModelsConfig | undefined;
}
