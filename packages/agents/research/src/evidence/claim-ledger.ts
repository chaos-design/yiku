import {
  type ResearchClaimManifest,
  type ResearchClaimRecord,
  sha256Digest,
  sha256Text,
} from "@yiku/evals";
import { canonicalResearchUrl, type EvidenceLedger } from "./evidence-ledger.js";
import type { ResearchClaimDraft } from "./types.js";

export type ResearchClaimErrorCode = "RESEARCH_CLAIM_INVALID" | "RESEARCH_CLAIM_LIMIT";

export class ResearchClaimError extends Error {
  public override readonly name = "ResearchClaimError";

  public constructor(
    public readonly code: ResearchClaimErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResearchClaimLedgerOptions {
  readonly evidenceLedger: EvidenceLedger;
  readonly maxClaims?: number | undefined;
  readonly onRecord?: ((claim: ResearchClaimRecord) => void) | undefined;
}

export class ResearchClaimLedger {
  private readonly claims = new Map<string, ResearchClaimRecord>();
  private readonly evidenceLedger: EvidenceLedger;
  private readonly listeners = new Set<(claim: ResearchClaimRecord) => void>();
  private readonly maxClaims: number;

  public constructor(options: ResearchClaimLedgerOptions) {
    this.evidenceLedger = options.evidenceLedger;
    this.maxClaims = options.maxClaims ?? 200;
    if (!Number.isSafeInteger(this.maxClaims) || this.maxClaims <= 0) {
      throw new ResearchClaimError(
        "RESEARCH_CLAIM_LIMIT",
        "Research claim limit must be a positive integer.",
      );
    }
    if (options.onRecord !== undefined) {
      this.listeners.add(options.onRecord);
    }
  }

  public manifest(report: string): ResearchClaimManifest {
    const claims = this.snapshot();
    const semantic = {
      claims,
      reportDigest: sha256Text(report),
      version: 1 as const,
    };
    return Object.freeze({
      ...semantic,
      digest: sha256Digest(semantic),
    });
  }

  public record(draft: ResearchClaimDraft): ResearchClaimRecord {
    const normalized = this.normalize(draft);
    const id = `claim-${sha256Text(normalized.statement)}`;
    const existing = this.claims.get(id);
    const claim = freezeClaim(
      existing === undefined
        ? {
            ...normalized,
            id,
          }
        : {
            ...existing,
            citationUrls: unique([...existing.citationUrls, ...normalized.citationUrls]),
            contradictsClaimIds: unique([
              ...(existing.contradictsClaimIds ?? []),
              ...(normalized.contradictsClaimIds ?? []),
            ]),
            evidenceIds: unique([...existing.evidenceIds, ...normalized.evidenceIds]),
            temporal: existing.temporal || normalized.temporal,
          },
    );
    if (existing === undefined && this.claims.size >= this.maxClaims) {
      throw new ResearchClaimError(
        "RESEARCH_CLAIM_LIMIT",
        `Research claim limit of ${this.maxClaims} was reached.`,
      );
    }
    this.claims.set(id, claim);
    this.notify(claim);
    return claim;
  }

  public snapshot(): readonly ResearchClaimRecord[] {
    return Object.freeze(
      [...this.claims.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    );
  }

  public subscribe(listener: (claim: ResearchClaimRecord) => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private normalize(draft: ResearchClaimDraft): Omit<ResearchClaimRecord, "id"> {
    const statement = requireText(draft.statement, "Research claim statement", 4_096);
    const evidence = new Map(this.evidenceLedger.snapshot().map((item) => [item.id, item]));
    const evidenceIds = unique(
      draft.evidenceIds.map((id) => requireText(id, "Research claim evidence ID", 128)),
    );
    if (evidenceIds.length === 0) {
      throw invalid("Research claim must reference at least one evidence record.");
    }
    const citationUrls = unique(draft.citationUrls.map(canonicalResearchUrl));
    if (citationUrls.length === 0) {
      throw invalid("Research claim must contain at least one citation URL.");
    }
    for (const evidenceId of evidenceIds) {
      const item = evidence.get(evidenceId);
      if (item === undefined) {
        throw invalid(`Research claim references unknown evidence ${evidenceId}.`);
      }
      if (!citationUrls.includes(item.url)) {
        throw invalid(`Research claim citation URLs do not include evidence ${evidenceId}.`);
      }
    }
    const contradictsClaimIds = unique(
      (draft.contradictsClaimIds ?? []).map((id) =>
        requireText(id, "Contradicted research claim ID", 128),
      ),
    );
    for (const claimId of contradictsClaimIds) {
      if (!this.claims.has(claimId)) {
        throw invalid(`Research claim contradicts unknown claim ${claimId}.`);
      }
    }
    if (typeof draft.temporal !== "boolean") {
      throw invalid("Research claim temporal must be a boolean.");
    }
    return {
      citationUrls,
      ...(contradictsClaimIds.length > 0 ? { contradictsClaimIds } : {}),
      evidenceIds,
      statement,
      temporal: draft.temporal,
    };
  }

  private notify(claim: ResearchClaimRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(claim);
      } catch {
        // Observers cannot alter Claim Ledger writes.
      }
    }
  }
}

function freezeClaim(claim: ResearchClaimRecord): ResearchClaimRecord {
  return Object.freeze({
    ...claim,
    citationUrls: Object.freeze([...claim.citationUrls]),
    ...(claim.contradictsClaimIds !== undefined
      ? { contradictsClaimIds: Object.freeze([...claim.contradictsClaimIds]) }
      : {}),
    evidenceIds: Object.freeze([...claim.evidenceIds]),
  });
}

function requireText(value: string, label: string, maximum: number): string {
  const normalized = value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum) {
    throw invalid(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].toSorted((left, right) => left.localeCompare(right)));
}

function invalid(message: string): ResearchClaimError {
  return new ResearchClaimError("RESEARCH_CLAIM_INVALID", message);
}
