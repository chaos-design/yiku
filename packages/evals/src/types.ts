import type { AtomicFlowRun, AtomicFlowSnapshot } from "@yiku/atomic-flow";

export type EvalMode = "async" | "blocking";
export type EvalPolicyMode = "enforce" | "observe";
export type EvalDimension =
  | "correctness"
  | "performance"
  | "resource-efficiency"
  | "safety-reliability";
export type EvalSeverity = "blocker" | "error" | "info" | "warning";
export type EvalCheckStatus = "error" | "failed" | "not-run" | "passed";
export type CompletionDecisionAction =
  | "accepted"
  | "degraded"
  | "needs-review"
  | "rejected"
  | "retry";

export interface EvalInput {
  readonly finalOutput: string;
  readonly flow: AtomicFlowSnapshot;
  readonly signal?: AbortSignal | undefined;
}

export interface EvalResult {
  readonly error?: string | undefined;
  readonly key: string;
  readonly label: string;
  readonly passed: boolean;
  readonly score: number;
  readonly summary: string;
}

export interface Evaluator {
  readonly key: string;
  readonly label: string;
  evaluate(input: EvalInput): Promise<EvalResult> | EvalResult;
}

export interface JudgeProvider {
  evaluate(input: EvalInput): Promise<EvalResult>;
}

export interface EvalRunnerOptions {
  readonly evaluators?: readonly Evaluator[] | undefined;
  readonly judge?: JudgeProvider | undefined;
  readonly passThreshold?: number | undefined;
}

export interface RunEvalsInput extends EvalInput {
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly parentInstanceId?: string | undefined;
}

export interface EvalScorecard {
  readonly averageScore: number;
  readonly passed: boolean;
  readonly results: readonly EvalResult[];
}

export interface EvalProfile {
  readonly checks: readonly EvalCheckDefinition[];
  readonly dimensionWeights: Readonly<Record<EvalDimension, number>>;
  readonly id: string;
  readonly limits: EvalProfileLimits;
  readonly mode: EvalPolicyMode;
  readonly qualityThreshold: number;
  readonly version: 1;
}

export interface EvalProfileLimits {
  readonly maxConcurrentChecks: number;
  readonly maxInputBytes: number;
  readonly maxRepairAttempts: 0 | 1;
  readonly timeoutMs: number;
}

export interface EvalCheckDefinition {
  readonly capability: string;
  readonly concurrencyGroup?: string | undefined;
  readonly config: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  readonly dimension: EvalDimension;
  readonly evaluator: string;
  readonly evidenceRequired: boolean;
  readonly id: string;
  readonly required: boolean;
  readonly severity: EvalSeverity;
  readonly timeoutMs: number;
  readonly weight: number;
}

export type EvalCheckSource =
  | "agent-factory"
  | "agent-suggestion"
  | "managed"
  | "project"
  | "user-acceptance";

export interface PlannedEvalCheck extends EvalCheckDefinition {
  readonly ordinal: number;
  readonly source: EvalCheckSource;
}

export interface EvalPlan {
  readonly attemptBudget: 1 | 2;
  readonly checks: readonly PlannedEvalCheck[];
  readonly createdAt: string;
  readonly digest: string;
  readonly mode: EvalPolicyMode;
  readonly profileId: string;
  readonly qualityThreshold: number;
  readonly runId: string;
  readonly taskId: string;
  readonly version: 1;
  readonly dimensionWeights: Readonly<Record<EvalDimension, number>>;
  readonly limits: EvalProfileLimits;
}

export interface EvalPlanInput {
  readonly agentFactoryChecks?: readonly EvalCheckDefinition[] | undefined;
  readonly agentSuggestedChecks?: readonly EvalCheckDefinition[] | undefined;
  readonly managedProfile?: EvalProfile | undefined;
  readonly profile: EvalProfile;
  readonly runId: string;
  readonly taskId: string;
  readonly userAcceptanceChecks?: readonly EvalCheckDefinition[] | undefined;
}

export interface AgentArtifactRef {
  readonly digest: string;
  readonly id: string;
  readonly kind:
    | "command-result"
    | "file-change"
    | "research-claim"
    | "research-evidence"
    | "research-report";
  readonly metadata: Readonly<Record<string, boolean | number | string>>;
  readonly sizeBytes: number;
  readonly storageRef: string;
}

export interface OperationReceipt {
  readonly artifactRefs: readonly string[];
  readonly completedAt: string;
  readonly operationId: string;
  readonly result: "completed" | "failed" | "partial" | "unknown";
  readonly resultDigest?: string | undefined;
}

export interface VerificationCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly envAllowlist: readonly string[];
  readonly id: string;
  readonly network: "allowlist" | "deny";
  readonly timeoutMs: number;
  readonly writePolicy: "isolated" | "read-only";
}

export interface ResearchClaimRecord {
  readonly citationUrls: readonly string[];
  readonly contradictsClaimIds?: readonly string[] | undefined;
  readonly evidenceIds: readonly string[];
  readonly id: string;
  readonly statement: string;
  readonly temporal: boolean;
}

export interface ResearchClaimManifest {
  readonly claims: readonly ResearchClaimRecord[];
  readonly digest: string;
  readonly reportDigest: string;
  readonly version: 1;
}

export interface EvalExecutionContext {
  readonly artifacts: readonly AgentArtifactRef[];
  readonly attemptId: string;
  readonly finalOutput: string;
  readonly finalOutputDigest: string;
  readonly flow: AtomicFlowSnapshot;
  readonly flowRef: string;
  readonly operationReceipts: readonly OperationReceipt[];
  readonly researchClaimManifest?: ResearchClaimManifest | undefined;
  readonly runId: string;
  readonly runtimeMetrics?: EvalRuntimeMetrics | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly taskId: string;
  readonly taskSnapshotRef: string;
}

export interface EvalRuntimeMetrics {
  readonly cpuMs?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly peakRssBytes?: number | undefined;
  readonly persistedBytes?: number | undefined;
  readonly schedulerOverheadMs?: number | undefined;
}

export interface EvalEvidence {
  readonly digest: string;
  readonly id: string;
  readonly metadata: Readonly<Record<string, boolean | number | string>>;
  readonly ref: string;
  readonly summary: string;
  readonly type: "artifact" | "command" | "flow" | "output" | "receipt" | "research" | "resource";
  readonly version: 1;
}

export interface EvalResourceUsage {
  readonly cpuMs?: number | undefined;
  readonly outputBytes?: number | undefined;
  readonly peakRssBytes?: number | undefined;
}

export interface EvalCheckResult {
  readonly dimension: EvalDimension;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
  readonly evaluator: string;
  readonly evidenceRefs: readonly string[];
  readonly feedback?: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly required: boolean;
  readonly resourceUsage?: EvalResourceUsage | undefined;
  readonly retryable: boolean;
  readonly score?: number | undefined;
  readonly severity: EvalSeverity;
  readonly status: EvalCheckStatus;
  readonly summary: string;
  readonly version: 1;
}

export interface EvaluationScorecard {
  readonly attemptId: string;
  readonly averageScore: number;
  readonly counts: Readonly<Record<EvalCheckStatus, number>>;
  readonly digest: string;
  readonly dimensionScores: Readonly<Record<EvalDimension, number>>;
  readonly durationMs: number;
  readonly finalOutputDigest: string;
  readonly grade: "A" | "B" | "C" | "D" | "S";
  readonly hardGatePassed: boolean;
  readonly overallScore: number;
  readonly passed: boolean;
  readonly planDigest: string;
  readonly qualityPassed: boolean;
  readonly results: readonly EvalCheckResult[];
  readonly runId: string;
  readonly taskId: string;
  readonly version: 1;
}

export interface EvalAttemptRecord {
  readonly attemptId: string;
  readonly contextDigest: string;
  readonly digest: string;
  readonly finishedAt: string;
  readonly planDigest: string;
  readonly scorecardDigest: string;
  readonly startedAt: string;
  readonly version: 1;
}

export interface EvalEvidenceIndex {
  readonly attemptId: string;
  readonly digest: string;
  readonly evidence: readonly EvalEvidence[];
  readonly version: 1;
}

export interface RepairInstruction {
  readonly failedCheckIds: readonly string[];
  readonly feedback: string;
}

export interface CompletionDecision {
  readonly action: CompletionDecisionAction;
  readonly attemptId: string;
  readonly digest: string;
  readonly reasons: readonly string[];
  readonly repairInstruction?: RepairInstruction | undefined;
  readonly runId: string;
  readonly taskId: string;
  readonly version: 1;
}

export interface EvaluatorDescriptor {
  readonly capability: string;
  readonly deterministic: boolean;
  readonly key: string;
  readonly label: string;
  readonly version: string;
}

export interface EvalCheckEvaluator {
  readonly descriptor: EvaluatorDescriptor;
  evaluate(
    check: PlannedEvalCheck,
    context: EvalExecutionContext,
  ): Promise<EvalCheckResult> | EvalCheckResult;
}

export interface EvalAttemptCommit {
  readonly attempt: EvalAttemptRecord;
  readonly evidenceIndex: EvalEvidenceIndex;
  readonly scorecard: EvaluationScorecard;
}

export interface EvalStoredAttempt extends EvalAttemptCommit {
  readonly decision?: CompletionDecision | undefined;
}

export interface EvalRunQuery {
  readonly cursor?: string | undefined;
  readonly decision?: CompletionDecisionAction | undefined;
  readonly limit: number;
  readonly profileId?: string | undefined;
}

export interface EvalRunSummary {
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly decision?: CompletionDecisionAction | undefined;
  readonly profileId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly updatedAt: string;
}

export interface EvalResultStore {
  initialize(): Promise<void>;
  listRuns(query: EvalRunQuery): Promise<readonly EvalRunSummary[]>;
  readAttempt(runId: string, attemptId: string): Promise<EvalStoredAttempt | undefined>;
  writeAttempt(commit: EvalAttemptCommit): Promise<void>;
  writeDecision(decision: CompletionDecision): Promise<void>;
  writePlan(plan: EvalPlan): Promise<void>;
}

export interface EvalBaselineCheck {
  readonly id: string;
  readonly score?: number | undefined;
  readonly status: EvalCheckStatus;
}

export interface EvalBaseline {
  readonly approvedAt: string;
  readonly approvedBy?: string | undefined;
  readonly baselineVersion: string;
  readonly checks: readonly EvalBaselineCheck[];
  readonly digest: string;
  readonly dimensionScores: Readonly<Record<EvalDimension, number>>;
  readonly evaluatorVersions: Readonly<Record<string, string>>;
  readonly hardGatePassed: boolean;
  readonly overallScore: number;
  readonly profileId: string;
  readonly runtimeDigest: string;
  readonly scorecardDigest: string;
  readonly suiteId: string;
  readonly version: 1;
}

export interface EvalBaselineComparison {
  readonly currentScore: number;
  readonly passed: boolean;
  readonly regressions: readonly string[];
  readonly scoreDelta: number;
  readonly version: 1;
}

export interface EvalBaselineStore {
  readBaseline(suiteId: string, baselineVersion: string): Promise<EvalBaseline | undefined>;
  writeBaseline(baseline: EvalBaseline): Promise<void>;
}

export type EvalCounterName =
  | "eval_checks_total"
  | "eval_errors_total"
  | "eval_repairs_total"
  | "eval_runs_total";

export type EvalHistogramName =
  | "eval_attempt_duration_ms"
  | "eval_check_duration_ms"
  | "eval_memory_rss_bytes"
  | "eval_persisted_bytes"
  | "eval_scheduler_queue_ms"
  | "eval_store_operation_ms";

export interface EvalMetricLabels {
  readonly component?: string | undefined;
  readonly decision?: CompletionDecisionAction | undefined;
  readonly errorCode?: string | undefined;
  readonly evaluator?: string | undefined;
  readonly mode?: EvalPolicyMode | undefined;
  readonly operation?: string | undefined;
  readonly profile?: string | undefined;
  readonly required?: "false" | "true" | undefined;
  readonly status?: EvalCheckStatus | "success" | undefined;
}

export interface EvalMetrics {
  increment(name: EvalCounterName, labels: EvalMetricLabels): void;
  observe(name: EvalHistogramName, value: number, labels: EvalMetricLabels): void;
}

export interface EvalLogEntry {
  readonly attemptId?: string | undefined;
  readonly checkId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly errorCode?: string | undefined;
  readonly event: string;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly runId?: string | undefined;
  readonly status?: string | undefined;
  readonly taskId?: string | undefined;
  readonly timestamp: string;
}

export interface EvalLogger {
  log(entry: EvalLogEntry): void;
}
