import {
  type AgentArtifactRef,
  createDefaultEvalProfile,
  DEFAULT_CHECK_EVALUATORS,
  type EvalCheckDefinition,
  type EvalCheckEvaluator,
  type EvalCheckResult,
  type EvalExecutionContext,
  type EvalPolicyMode,
  type EvalProfile,
  EvaluationError,
  type PlannedEvalCheck,
  sha256Digest,
  sha256Text,
} from "@yiku/evals";
import type { ResearchClaimLedger } from "../evidence/claim-ledger.js";
import type { EvidenceLedger } from "../evidence/evidence-ledger.js";
import {
  type ResearchReportValidationOptions,
  validateResearchReport,
} from "../evidence/report-validator.js";

export class ResearchClaimCitationEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-claim-citation",
    "research-claim-citation",
    "Research Claim Citation",
  );

  public constructor(
    private readonly evidenceLedger: EvidenceLedger,
    private readonly claimLedger: ResearchClaimLedger,
    private readonly options: ResearchReportValidationOptions = {},
  ) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    this.validateManifest(context);
    const validation = this.validation(context);
    const score = ((validation.citationPrecision ?? 0) + (validation.citationRecall ?? 0)) / 2;
    const passed =
      validation.unsupportedClaimCount === 0 &&
      validation.citationPrecision === 1 &&
      validation.citationRecall === 1;
    return researchResult(
      check,
      this.descriptor.label,
      passed,
      score,
      passed
        ? "Every structured claim has valid citation evidence."
        : validation.diagnostics.join("; "),
      this.evidenceLedger,
      true,
    );
  }

  private validation(context: EvalExecutionContext) {
    return validateResearchReport(
      context.finalOutput,
      this.evidenceLedger,
      this.claimLedger,
      this.options,
    );
  }

  private validateManifest(context: EvalExecutionContext): void {
    if (context.researchClaimManifest === undefined) {
      throw new EvaluationError("EVAL_EVIDENCE_MISSING", "Research Claim Manifest is unavailable.");
    }
    const current = this.claimLedger.manifest(context.finalOutput);
    if (
      current.digest !== context.researchClaimManifest.digest ||
      current.reportDigest !== context.researchClaimManifest.reportDigest
    ) {
      throw new EvaluationError(
        "EVAL_ARTIFACT_CHANGED",
        "Research Claim Manifest changed before evaluation.",
      );
    }
  }
}

export class ResearchSourceAuthorityEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-source-authority",
    "research-source-authority",
    "Research Source Authority",
  );

  public constructor(
    private readonly evidenceLedger: EvidenceLedger,
    private readonly claimLedger: ResearchClaimLedger,
    private readonly options: ResearchReportValidationOptions = {},
  ) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const validation = validateResearchReport(
      context.finalOutput,
      this.evidenceLedger,
      this.claimLedger,
      this.options,
    );
    const score = validation.sourceAuthorityScore ?? 0;
    const threshold = configScore(check, "minimumScore", 0.7);
    return researchResult(
      check,
      this.descriptor.label,
      score >= threshold,
      score,
      `Source authority score is ${score.toFixed(3)}; required ${threshold.toFixed(3)}.`,
      this.evidenceLedger,
      false,
    );
  }
}

export class ResearchFreshnessEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-freshness",
    "research-freshness",
    "Research Freshness",
  );

  public constructor(
    private readonly evidenceLedger: EvidenceLedger,
    private readonly claimLedger: ResearchClaimLedger,
    private readonly options: ResearchReportValidationOptions = {},
  ) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const validation = validateResearchReport(
      context.finalOutput,
      this.evidenceLedger,
      this.claimLedger,
      this.options,
    );
    const score = validation.freshnessScore ?? 0;
    return researchResult(
      check,
      this.descriptor.label,
      score === 1,
      score,
      score === 1
        ? "Every temporal claim has fresh evidence."
        : "One or more temporal claims lack fresh evidence.",
      this.evidenceLedger,
      true,
    );
  }
}

export class ResearchDiversityEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-diversity",
    "research-diversity",
    "Research Source Diversity",
  );

  public constructor(
    private readonly evidenceLedger: EvidenceLedger,
    private readonly claimLedger: ResearchClaimLedger,
    private readonly options: ResearchReportValidationOptions = {},
  ) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const validation = validateResearchReport(
      context.finalOutput,
      this.evidenceLedger,
      this.claimLedger,
      this.options,
    );
    const score = validation.diversityScore ?? 0;
    const threshold = configScore(check, "minimumScore", 1);
    return researchResult(
      check,
      this.descriptor.label,
      score >= threshold,
      score,
      `Source diversity score is ${score.toFixed(3)}; required ${threshold.toFixed(3)}.`,
      this.evidenceLedger,
      false,
    );
  }
}

export class ResearchContradictionEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-contradiction",
    "research-contradiction",
    "Research Contradiction Handling",
  );

  public constructor(
    private readonly evidenceLedger: EvidenceLedger,
    private readonly claimLedger: ResearchClaimLedger,
    private readonly options: ResearchReportValidationOptions = {},
  ) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const validation = validateResearchReport(
      context.finalOutput,
      this.evidenceLedger,
      this.claimLedger,
      this.options,
    );
    const score = validation.contradictionCoverage ?? 0;
    return researchResult(
      check,
      this.descriptor.label,
      score === 1,
      score,
      score === 1
        ? "Every recorded contradiction is represented in the report."
        : "The report omits a recorded contradiction.",
      this.evidenceLedger,
      true,
    );
  }
}

export class ResearchReportStructureEvaluator implements EvalCheckEvaluator {
  public readonly descriptor = descriptor(
    "research-report-structure",
    "research-report-structure",
    "Research Report Structure",
  );

  public constructor(private readonly evidenceLedger: EvidenceLedger) {}

  public evaluate(check: PlannedEvalCheck, context: EvalExecutionContext): EvalCheckResult {
    const validation = validateResearchReport(context.finalOutput, this.evidenceLedger);
    return researchResult(
      check,
      this.descriptor.label,
      validation.passed,
      validation.passed ? 1 : 0,
      validation.passed ? "Research report structure is valid." : validation.diagnostics.join("; "),
      this.evidenceLedger,
      true,
    );
  }
}

export interface ResearchEvalProfileOptions {
  readonly freshnessDays?: number | undefined;
  readonly id?: string | undefined;
  readonly maxConcurrentChecks?: number | undefined;
  readonly maxRepairAttempts?: 0 | 1 | undefined;
  readonly minimumIndependentDomains?: number | undefined;
  readonly mode?: EvalPolicyMode | undefined;
  readonly qualityThreshold?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createResearchEvalProfile(options: ResearchEvalProfileOptions = {}): EvalProfile {
  const generic = createDefaultEvalProfile({
    id: options.id ?? "research-default",
    ...(options.maxConcurrentChecks !== undefined
      ? { maxConcurrentChecks: options.maxConcurrentChecks }
      : {}),
    ...(options.maxRepairAttempts !== undefined
      ? { maxRepairAttempts: options.maxRepairAttempts }
      : {}),
    mode: options.mode ?? "enforce",
    ...(options.qualityThreshold !== undefined
      ? { qualityThreshold: options.qualityThreshold }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const checks: EvalCheckDefinition[] = [
    researchCheck("research-report-structure", "correctness", "error", 1),
    researchCheck("research-claim-citation", "correctness", "blocker", 1, [
      "research-report-structure",
    ]),
    {
      ...researchCheck("research-source-authority", "correctness", "error", 1, [
        "research-claim-citation",
      ]),
      config: Object.freeze({ minimumScore: 0.7 }),
    },
    researchCheck("research-freshness", "correctness", "error", 1, ["research-claim-citation"]),
    {
      ...researchCheck("research-diversity", "correctness", "warning", 1, [
        "research-claim-citation",
      ]),
      config: Object.freeze({ minimumScore: 1 }),
    },
    researchCheck("research-contradiction", "safety-reliability", "error", 1, [
      "research-claim-citation",
    ]),
  ];
  return Object.freeze({
    ...generic,
    checks: Object.freeze([...generic.checks, ...checks]),
  });
}

export function createResearchEvaluators(
  evidenceLedger: EvidenceLedger,
  claimLedger: ResearchClaimLedger,
  options: ResearchReportValidationOptions = {},
): readonly EvalCheckEvaluator[] {
  return Object.freeze([
    ...DEFAULT_CHECK_EVALUATORS,
    new ResearchReportStructureEvaluator(evidenceLedger),
    new ResearchClaimCitationEvaluator(evidenceLedger, claimLedger, options),
    new ResearchSourceAuthorityEvaluator(evidenceLedger, claimLedger, options),
    new ResearchFreshnessEvaluator(evidenceLedger, claimLedger, options),
    new ResearchDiversityEvaluator(evidenceLedger, claimLedger, options),
    new ResearchContradictionEvaluator(evidenceLedger, claimLedger, options),
  ]);
}

function descriptor(key: string, capability: string, label: string) {
  return Object.freeze({
    capability,
    deterministic: true,
    key,
    label,
    version: "1.0.0",
  });
}

function researchCheck(
  id: string,
  dimension: EvalCheckDefinition["dimension"],
  severity: EvalCheckDefinition["severity"],
  weight: number,
  dependsOn: readonly string[] = [],
): EvalCheckDefinition {
  return Object.freeze({
    capability: id,
    config: Object.freeze({}),
    dependsOn: Object.freeze([...dependsOn]),
    dimension,
    evaluator: id,
    evidenceRequired: true,
    id,
    required: true,
    severity,
    timeoutMs: 30_000,
    weight,
  });
}

function researchResult(
  check: PlannedEvalCheck,
  label: string,
  passed: boolean,
  score: number,
  summary: string,
  ledger: EvidenceLedger,
  retryable: boolean,
): EvalCheckResult {
  return Object.freeze({
    dimension: check.dimension,
    durationMs: 0,
    evaluator: check.evaluator,
    evidenceRefs: Object.freeze(ledger.snapshot().map((evidence) => `research:${evidence.id}`)),
    id: check.id,
    label,
    passed,
    required: check.required,
    retryable: !passed && retryable,
    score,
    severity: check.severity,
    status: passed ? "passed" : "failed",
    summary: summary.slice(0, 2_000),
    version: 1,
  });
}

function configScore(check: PlannedEvalCheck, key: string, fallback: number): number {
  const value = check.config[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Research check ${check.id} config ${key} must be between 0 and 1.`,
    );
  }
  return value;
}

export function researchReportArtifact(report: string) {
  const digest = sha256Text(report);
  return Object.freeze({
    digest,
    id: `research-report-${digest}`,
    kind: "research-report" as const,
    metadata: Object.freeze({
      characters: report.length,
    }),
    sizeBytes: Buffer.byteLength(report, "utf8"),
    storageRef: `research-report:sha256:${digest}`,
  });
}

export function researchEvidenceArtifacts(ledger: EvidenceLedger): readonly AgentArtifactRef[] {
  return Object.freeze(
    ledger.snapshot().map((evidence) => {
      const digest = sha256Digest(evidence);
      return Object.freeze({
        digest,
        id: `research-evidence-${evidence.id}`,
        kind: "research-evidence" as const,
        metadata: Object.freeze({
          accessedAt: evidence.accessedAt,
          claims: evidence.claims.length,
          publishedAt: evidence.publishedAt ?? "",
          sourceType: evidence.sourceType,
          title: evidence.title,
          url: evidence.url,
          verification: evidence.verification,
        }),
        sizeBytes: Buffer.byteLength(JSON.stringify(evidence), "utf8"),
        storageRef: `research:evidence:${evidence.id}`,
      });
    }),
  );
}
