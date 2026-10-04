import type { ResearchClaimRecord } from "@yiku/evals";
import type { ResearchClaimLedger } from "./claim-ledger.js";
import { canonicalResearchUrl, type EvidenceLedger } from "./evidence-ledger.js";
import type { ResearchReportValidation } from "./types.js";

const CITATION_PATTERN = /\bhttps?:\/\/[^\s<>\]})`"'，。；：！？、]+/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu;
const INLINE_CODE_PATTERN = /`[^`\n]*`/gu;

export function validateResearchReport(
  report: string,
  ledger: EvidenceLedger,
  claimLedger?: ResearchClaimLedger,
  options: ResearchReportValidationOptions = {},
): ResearchReportValidation {
  const diagnostics: string[] = [];
  const evidence = ledger.snapshot();
  const primarySourceCount = evidence.filter((item) => item.sourceType === "primary").length;
  const evidenceUrls = new Set(evidence.map((item) => item.url));
  const citations = reportCitations(report);

  if (!report.trim()) {
    diagnostics.push("Research report is empty.");
  }
  if (evidence.length === 0) {
    diagnostics.push("Research report has no recorded evidence.");
  }
  if (evidence.length > 0 && citations.length === 0) {
    diagnostics.push("Research report does not cite its recorded evidence.");
  }
  for (const citation of citations) {
    if (!evidenceUrls.has(citation)) {
      diagnostics.push(`Citation is not present in the Evidence Ledger: ${citation}`);
    }
  }
  if (evidence.length > 0 && primarySourceCount === 0 && ledger.independentDomainCount() < 2) {
    diagnostics.push("Key conclusions require a primary source or two independent source domains.");
  }

  const base = {
    evidenceCount: evidence.length,
    primarySourceCount,
  };
  if (claimLedger === undefined) {
    return Object.freeze({
      ...base,
      diagnostics: Object.freeze(diagnostics),
      passed: diagnostics.length === 0,
    });
  }
  const claimValidation = validateClaims(report, claimLedger.snapshot(), evidence, options);
  diagnostics.push(...claimValidation.diagnostics);
  return Object.freeze({
    ...base,
    ...claimValidation.metrics,
    diagnostics: Object.freeze(diagnostics),
    passed: diagnostics.length === 0,
  });
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export interface ResearchReportValidationOptions {
  readonly freshnessDays?: number | undefined;
  readonly minimumIndependentDomains?: number | undefined;
  readonly now?: Date | undefined;
}

function validateClaims(
  report: string,
  claims: readonly ResearchClaimRecord[],
  evidence: ReturnType<EvidenceLedger["snapshot"]>,
  options: ResearchReportValidationOptions,
) {
  const diagnostics: string[] = [];
  const paragraphs = report
    .split(/\n\s*\n/gu)
    .map((paragraph) => ({
      citations: reportCitations(paragraph),
      text: normalizeText(paragraph),
    }))
    .filter((paragraph) => paragraph.text);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const evaluations = claims.map((claim) => {
    const paragraph = paragraphs.find((item) => item.text.includes(normalizeText(claim.statement)));
    const validEvidence = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item) => item !== undefined);
    const supported =
      paragraph !== undefined &&
      validEvidence.length === claim.evidenceIds.length &&
      validEvidence.some((item) => paragraph.citations.includes(item.url));
    return {
      claim,
      paragraph,
      supported,
      validEvidence,
    };
  });
  const present = evaluations.filter((item) => item.paragraph !== undefined);
  const supported = evaluations.filter((item) => item.supported);
  const unsupportedClaimCount = present.filter((item) => !item.supported).length;
  const citationPrecision = ratio(supported.length, present.length);
  const citationRecall = ratio(supported.length, claims.length);
  if (claims.length === 0) {
    diagnostics.push("Research report has no structured Claim Manifest.");
  }
  if (unsupportedClaimCount > 0) {
    diagnostics.push(
      `Research report contains ${unsupportedClaimCount} unsupported structured claim(s).`,
    );
  }
  if (claims.length > 0 && citationRecall < 1) {
    diagnostics.push("Research report does not use every structured claim with valid evidence.");
  }

  const authorityValues = supported.flatMap((item) =>
    item.validEvidence.map((source) =>
      source.sourceType === "primary" ? 1 : source.sourceType === "independent" ? 0.8 : 0.5,
    ),
  );
  const sourceAuthorityScore = average(authorityValues);
  const now = options.now ?? new Date();
  const freshnessDays = positiveInteger(options.freshnessDays ?? 180, "Research freshness days");
  const temporal = evaluations.filter((item) => item.claim.temporal);
  const freshnessScore = ratio(
    temporal.filter((item) =>
      item.validEvidence.some(
        (source) =>
          source.publishedAt !== undefined &&
          now.getTime() - Date.parse(source.publishedAt) <= freshnessDays * 86_400_000,
      ),
    ).length,
    temporal.length,
  );
  if (temporal.length > 0 && freshnessScore < 1) {
    diagnostics.push("One or more temporal claims do not have fresh evidence.");
  }

  const domains = new Set(
    supported.flatMap((item) => item.validEvidence.map((source) => registrableDomain(source.url))),
  );
  const minimumDomains = positiveInteger(
    options.minimumIndependentDomains ?? 2,
    "Research minimum independent domains",
  );
  const diversityScore = Math.min(1, domains.size / minimumDomains);
  const contradictory = evaluations.filter(
    (item) => (item.claim.contradictsClaimIds?.length ?? 0) > 0,
  );
  const contradictionCoverage = ratio(
    contradictory.filter(
      (item) =>
        item.paragraph !== undefined &&
        item.claim.contradictsClaimIds?.every((id) => {
          const contradicted = claims.find((candidate) => candidate.id === id);
          return (
            contradicted !== undefined &&
            normalizeText(report).includes(normalizeText(contradicted.statement))
          );
        }),
    ).length,
    contradictory.length,
  );
  if (contradictory.length > 0 && contradictionCoverage < 1) {
    diagnostics.push("Research report does not explain every recorded contradiction.");
  }

  return {
    diagnostics,
    metrics: {
      citationPrecision,
      citationRecall,
      claimCount: claims.length,
      contradictionCoverage,
      diversityScore,
      freshnessScore,
      sourceAuthorityScore,
      unsupportedClaimCount,
    },
  };
}

function reportCitations(report: string): readonly string[] {
  const prose = report.replace(FENCED_CODE_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
  return unique(
    [...prose.matchAll(CITATION_PATTERN)].flatMap((match) => {
      const value = match[0]?.replace(/[.,;:!?]+$/u, "");
      if (!value) {
        return [];
      }
      try {
        return [canonicalResearchUrl(value)];
      } catch {
        return [];
      }
    }),
  );
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function registrableDomain(value: string): string {
  const hostname = new URL(value).hostname.toLocaleLowerCase();
  const parts = hostname.split(".").filter(Boolean);
  return parts.length < 2 ? hostname : parts.slice(-2).join(".");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
