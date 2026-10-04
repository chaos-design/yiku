import { describe, expect, it, vi } from "vitest";
import { ResearchClaimError, ResearchClaimLedger } from "../../src/evidence/claim-ledger.js";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";

describe("ResearchClaimLedger", () => {
  it("records canonical claim-evidence mappings and creates stable manifests", () => {
    const evidenceLedger = new EvidenceLedger();
    const evidence = evidenceLedger.record({
      claims: ["API 已发布"],
      sourceType: "primary",
      title: "官方公告",
      url: "https://example.com/release",
      verification: "single-source",
    });
    const claimLedger = new ResearchClaimLedger({ evidenceLedger });
    const claim = claimLedger.record({
      citationUrls: ["HTTPS://EXAMPLE.COM:443/release#section"],
      evidenceIds: [evidence.id],
      statement: "  API   已发布  ",
      temporal: false,
    });
    const duplicate = claimLedger.record({
      citationUrls: ["https://example.com/release"],
      evidenceIds: [evidence.id],
      statement: "API 已发布",
      temporal: true,
    });
    const report = "API 已发布 https://example.com/release";

    expect(duplicate).toMatchObject({
      id: claim.id,
      statement: "API 已发布",
      temporal: true,
    });
    expect(claimLedger.snapshot()).toHaveLength(1);
    expect(claimLedger.manifest(report)).toMatchObject({
      claims: [duplicate],
      version: 1,
    });
    expect(claimLedger.manifest(report).digest).toBe(claimLedger.manifest(report).digest);
  });

  it("rejects missing evidence, mismatched citations, and unknown contradictions", () => {
    const evidenceLedger = new EvidenceLedger();
    const evidence = evidenceLedger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });
    const ledger = new ResearchClaimLedger({ evidenceLedger });
    expect(() =>
      ledger.record({
        citationUrls: [evidence.url],
        evidenceIds: ["missing"],
        statement: "Claim",
        temporal: false,
      }),
    ).toThrow("unknown evidence");
    expect(() =>
      ledger.record({
        citationUrls: ["https://other.test/source"],
        evidenceIds: [evidence.id],
        statement: "Claim",
        temporal: false,
      }),
    ).toThrow("do not include evidence");
    expect(() =>
      ledger.record({
        citationUrls: [evidence.url],
        contradictsClaimIds: ["claim-missing"],
        evidenceIds: [evidence.id],
        statement: "Claim",
        temporal: false,
      }),
    ).toThrow("unknown claim");
  });

  it("records contradiction relationships and enforces limits", () => {
    const evidenceLedger = new EvidenceLedger();
    const firstEvidence = evidenceLedger.record({
      claims: ["First"],
      sourceType: "primary",
      title: "First",
      url: "https://example.com/first",
      verification: "corroborated",
    });
    const secondEvidence = evidenceLedger.record({
      claims: ["Second"],
      sourceType: "independent",
      title: "Second",
      url: "https://other.test/second",
      verification: "corroborated",
    });
    const ledger = new ResearchClaimLedger({
      evidenceLedger,
      maxClaims: 2,
    });
    const first = ledger.record({
      citationUrls: [firstEvidence.url],
      evidenceIds: [firstEvidence.id],
      statement: "First",
      temporal: false,
    });
    const second = ledger.record({
      citationUrls: [secondEvidence.url],
      contradictsClaimIds: [first.id],
      evidenceIds: [secondEvidence.id],
      statement: "Second",
      temporal: false,
    });

    expect(second.contradictsClaimIds).toEqual([first.id]);
    expect(() =>
      ledger.record({
        citationUrls: [firstEvidence.url],
        evidenceIds: [firstEvidence.id],
        statement: "Third",
        temporal: false,
      }),
    ).toThrow(ResearchClaimError);
    expect(
      () =>
        new ResearchClaimLedger({
          evidenceLedger,
          maxClaims: 0,
        }),
    ).toThrow("positive integer");
  });

  it("notifies observers without allowing observer errors to alter claims", () => {
    const evidenceLedger = new EvidenceLedger();
    const evidence = evidenceLedger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });
    const listener = vi.fn(() => {
      throw new Error("observer");
    });
    const ledger = new ResearchClaimLedger({
      evidenceLedger,
      onRecord: listener,
    });
    const claim = ledger.record({
      citationUrls: [evidence.url],
      evidenceIds: [evidence.id],
      statement: "Claim",
      temporal: false,
    });

    expect(listener).toHaveBeenCalledWith(claim);
    expect(ledger.snapshot()).toEqual([claim]);
    expect(Object.isFrozen(claim)).toBe(true);
  });

  it("validates empty claim fields, temporal flags, and configured text limits", () => {
    const evidenceLedger = new EvidenceLedger();
    const evidence = evidenceLedger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });
    const ledger = new ResearchClaimLedger({ evidenceLedger });
    for (const draft of [
      {
        citationUrls: [evidence.url],
        evidenceIds: [],
        statement: "Claim",
        temporal: false,
      },
      {
        citationUrls: [],
        evidenceIds: [evidence.id],
        statement: "Claim",
        temporal: false,
      },
      {
        citationUrls: [evidence.url],
        evidenceIds: [evidence.id],
        statement: " ",
        temporal: false,
      },
      {
        citationUrls: [evidence.url],
        evidenceIds: [evidence.id],
        statement: "x".repeat(4_097),
        temporal: false,
      },
      {
        citationUrls: [evidence.url],
        evidenceIds: [evidence.id],
        statement: "Claim",
        temporal: "false",
      },
    ]) {
      expect(() => ledger.record(draft as Parameters<ResearchClaimLedger["record"]>[0])).toThrow(
        ResearchClaimError,
      );
    }
  });

  it("merges contradiction relationships and unsubscribes observers idempotently", () => {
    const evidenceLedger = new EvidenceLedger();
    const firstEvidence = evidenceLedger.record({
      claims: ["First"],
      sourceType: "primary",
      title: "First",
      url: "https://example.com/first",
      verification: "corroborated",
    });
    const secondEvidence = evidenceLedger.record({
      claims: ["Second"],
      sourceType: "independent",
      title: "Second",
      url: "https://other.test/second",
      verification: "corroborated",
    });
    const ledger = new ResearchClaimLedger({ evidenceLedger });
    const listener = vi.fn();
    const unsubscribe = ledger.subscribe(listener);
    const first = ledger.record({
      citationUrls: [firstEvidence.url],
      evidenceIds: [firstEvidence.id],
      statement: "First",
      temporal: false,
    });
    ledger.record({
      citationUrls: [secondEvidence.url],
      evidenceIds: [secondEvidence.id],
      statement: "Second",
      temporal: false,
    });
    const merged = ledger.record({
      citationUrls: [secondEvidence.url],
      contradictsClaimIds: [first.id],
      evidenceIds: [secondEvidence.id],
      statement: "Second",
      temporal: false,
    });
    unsubscribe();
    unsubscribe();
    ledger.record({
      citationUrls: [firstEvidence.url],
      evidenceIds: [firstEvidence.id],
      statement: "Third",
      temporal: false,
    });

    expect(merged.contradictsClaimIds).toEqual([first.id]);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
