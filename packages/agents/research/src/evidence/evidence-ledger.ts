import { createHash } from "node:crypto";
import type {
  ResearchEvidence,
  ResearchEvidenceDraft,
  ResearchEvidenceVerification,
  ResearchSourceType,
} from "./types.js";

export type ResearchEvidenceErrorCode = "RESEARCH_EVIDENCE_INVALID" | "RESEARCH_EVIDENCE_LIMIT";

export class ResearchEvidenceError extends Error {
  public override readonly name = "ResearchEvidenceError";

  public constructor(
    public readonly code: ResearchEvidenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface EvidenceLedgerOptions {
  readonly maxEvidence?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onRecord?: ((evidence: ResearchEvidence) => void) | undefined;
}

export class EvidenceLedger {
  private readonly evidence = new Map<string, ResearchEvidence>();
  private readonly listeners = new Set<(evidence: ResearchEvidence) => void>();
  private readonly maxEvidence: number;
  private readonly now: () => Date;

  public constructor(options: EvidenceLedgerOptions = {}) {
    this.maxEvidence = options.maxEvidence ?? 50;
    this.now = options.now ?? (() => new Date());
    if (options.onRecord !== undefined) {
      this.listeners.add(options.onRecord);
    }
    if (!Number.isSafeInteger(this.maxEvidence) || this.maxEvidence <= 0) {
      throw new Error("Evidence limit must be a positive integer.");
    }
  }

  public independentDomainCount(): number {
    return new Set(this.snapshot().map((evidence) => registrableDomain(evidence.url))).size;
  }

  public record(draft: ResearchEvidenceDraft): ResearchEvidence {
    const normalized = normalizeDraft(draft);
    const id = createHash("sha256").update(normalized.url).digest("hex");
    const existing = this.evidence.get(id);
    if (existing !== undefined) {
      const merged = freezeEvidence({
        ...existing,
        claims: unique([...existing.claims, ...normalized.claims]),
        ...(normalized.publishedAt !== undefined ? { publishedAt: normalized.publishedAt } : {}),
        sourceType: strongerSourceType(existing.sourceType, normalized.sourceType),
        title: normalized.title.length > existing.title.length ? normalized.title : existing.title,
        verification: strongerVerification(existing.verification, normalized.verification),
      });
      this.evidence.set(id, merged);
      this.notify(merged);
      return merged;
    }
    if (this.evidence.size >= this.maxEvidence) {
      throw new ResearchEvidenceError(
        "RESEARCH_EVIDENCE_LIMIT",
        `Evidence limit of ${this.maxEvidence} unique sources was reached.`,
      );
    }

    const evidence = freezeEvidence({
      accessedAt: this.now().toISOString(),
      ...normalized,
      id,
    });
    this.evidence.set(id, evidence);
    this.notify(evidence);
    return evidence;
  }

  public snapshot(): readonly ResearchEvidence[] {
    return Object.freeze([...this.evidence.values()]);
  }

  public subscribe(listener: (evidence: ResearchEvidence) => void): () => void {
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

  private notify(evidence: ResearchEvidence): void {
    for (const listener of this.listeners) {
      try {
        listener(evidence);
      } catch {
        // Observers cannot alter Evidence Ledger writes.
      }
    }
  }
}

function normalizeDraft(draft: ResearchEvidenceDraft): ResearchEvidenceDraft {
  const title = requireText(draft.title, "Evidence title", 1_000);
  const claims = unique(draft.claims.map((claim) => requireText(claim, "Evidence claim", 4_096)));
  if (claims.length === 0) {
    throw new ResearchEvidenceError(
      "RESEARCH_EVIDENCE_INVALID",
      "Evidence must support at least one claim.",
    );
  }
  const url = canonicalResearchUrl(draft.url);
  const publishedAt = draft.publishedAt?.trim();
  if (publishedAt && Number.isNaN(Date.parse(publishedAt))) {
    throw new ResearchEvidenceError(
      "RESEARCH_EVIDENCE_INVALID",
      "Evidence publishedAt must be a valid date.",
    );
  }

  return {
    claims,
    ...(publishedAt ? { publishedAt: new Date(publishedAt).toISOString() } : {}),
    sourceType: draft.sourceType,
    title,
    url,
    verification: draft.verification,
  };
}

export function canonicalResearchUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ResearchEvidenceError("RESEARCH_EVIDENCE_INVALID", "Evidence URL must be valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchEvidenceError(
      "RESEARCH_EVIDENCE_INVALID",
      "Evidence URL must use HTTP or HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw new ResearchEvidenceError(
      "RESEARCH_EVIDENCE_INVALID",
      "Evidence URL must not contain credentials.",
    );
  }

  const parameters = [...url.searchParams.entries()].toSorted(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  url.hash = "";
  url.search = "";
  for (const [key, item] of parameters) {
    url.searchParams.append(key, item);
  }
  return url.toString();
}

function freezeEvidence(evidence: ResearchEvidence): ResearchEvidence {
  return Object.freeze({
    ...evidence,
    claims: Object.freeze([...evidence.claims]),
  });
}

function strongerSourceType(
  left: ResearchSourceType,
  right: ResearchSourceType,
): ResearchSourceType {
  const rank: Readonly<Record<ResearchSourceType, number>> = {
    independent: 2,
    primary: 3,
    secondary: 1,
  };
  return rank[right] > rank[left] ? right : left;
}

function strongerVerification(
  left: ResearchEvidenceVerification,
  right: ResearchEvidenceVerification,
): ResearchEvidenceVerification {
  const rank: Readonly<Record<ResearchEvidenceVerification, number>> = {
    corroborated: 3,
    "single-source": 2,
    unverified: 1,
  };
  return rank[right] > rank[left] ? right : left;
}

function registrableDomain(value: string): string {
  const hostname = new URL(value).hostname.toLocaleLowerCase();
  const parts = hostname.split(".").filter(Boolean);
  return parts.length < 2 ? hostname : parts.slice(-2).join(".");
}

function requireText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchEvidenceError("RESEARCH_EVIDENCE_INVALID", `${label} must be non-empty.`);
  }
  if (normalized.length > maximum) {
    throw new ResearchEvidenceError(
      "RESEARCH_EVIDENCE_INVALID",
      `${label} must contain at most ${maximum} characters.`,
    );
  }
  return normalized;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].toSorted((left, right) => left.localeCompare(right)));
}
