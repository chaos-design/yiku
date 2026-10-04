import type { ResearchClaimManifest, ResearchClaimRecord } from "@yiku/evals";

export interface ResearchBrief {
  readonly audience?: string | undefined;
  readonly deliverable: string;
  readonly question: string;
  readonly scope?: string | undefined;
  readonly timeHorizon?: string | undefined;
}

export type ResearchSourceType = "independent" | "primary" | "secondary";
export type ResearchEvidenceVerification = "corroborated" | "single-source" | "unverified";

export interface ResearchEvidence {
  readonly accessedAt: string;
  readonly claims: readonly string[];
  readonly id: string;
  readonly publishedAt?: string | undefined;
  readonly sourceType: ResearchSourceType;
  readonly title: string;
  readonly url: string;
  readonly verification: ResearchEvidenceVerification;
}

export interface ResearchEvidenceDraft {
  readonly claims: readonly string[];
  readonly publishedAt?: string | undefined;
  readonly sourceType: ResearchSourceType;
  readonly title: string;
  readonly url: string;
  readonly verification: ResearchEvidenceVerification;
}

export interface ResearchReportValidation {
  readonly citationPrecision?: number | undefined;
  readonly citationRecall?: number | undefined;
  readonly claimCount?: number | undefined;
  readonly contradictionCoverage?: number | undefined;
  readonly diagnostics: readonly string[];
  readonly diversityScore?: number | undefined;
  readonly evidenceCount: number;
  readonly freshnessScore?: number | undefined;
  readonly passed: boolean;
  readonly primarySourceCount: number;
  readonly sourceAuthorityScore?: number | undefined;
  readonly unsupportedClaimCount?: number | undefined;
}

export interface ResearchClaimDraft {
  readonly citationUrls: readonly string[];
  readonly contradictsClaimIds?: readonly string[] | undefined;
  readonly evidenceIds: readonly string[];
  readonly statement: string;
  readonly temporal: boolean;
}

export type ResearchClaim = ResearchClaimRecord;
export type ResearchManifest = ResearchClaimManifest;
