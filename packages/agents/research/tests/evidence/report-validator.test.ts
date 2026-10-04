import { describe, expect, it } from "vitest";
import { ResearchClaimLedger } from "../../src/evidence/claim-ledger.js";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";
import { validateResearchReport } from "../../src/evidence/report-validator.js";

describe("validateResearchReport", () => {
  it("accepts reports whose citations are backed by primary evidence", () => {
    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["The API was released."],
      sourceType: "primary",
      title: "Official release",
      url: "https://example.com/release",
      verification: "single-source",
    });

    expect(
      validateResearchReport(
        "The API was released [according to the official announcement](https://example.com/release).\n\n## Sources\n- [Official release](https://example.com/release)",
        ledger,
      ),
    ).toEqual({
      diagnostics: [],
      evidenceCount: 1,
      passed: true,
      primarySourceCount: 1,
    });
  });

  it("ignores code URL literals and stops citations at Chinese punctuation", () => {
    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["The API was released."],
      sourceType: "primary",
      title: "Official release",
      url: "https://example.com/release",
      verification: "single-source",
    });
    const report = [
      "Call `https://api.openai.com/v1/responses`。",
      "```sh\ncurl https://unknown.test/not-a-citation\n```",
      "Official source: https://example.com/release。后续说明。",
    ].join("\n\n");

    expect(validateResearchReport(report, ledger)).toEqual({
      diagnostics: [],
      evidenceCount: 1,
      passed: true,
      primarySourceCount: 1,
    });
  });

  it("rejects missing, unknown, and insufficient citations", () => {
    const empty = validateResearchReport(
      "A definitive unsupported conclusion.",
      new EvidenceLedger(),
    );
    expect(empty.passed).toBe(false);
    expect(empty.diagnostics).toContain("Research report has no recorded evidence.");

    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["A"],
      sourceType: "secondary",
      title: "Secondary",
      url: "https://example.com/secondary",
      verification: "single-source",
    });
    const unknown = validateResearchReport("[Unknown source](https://unknown.test/report)", ledger);
    expect(unknown.passed).toBe(false);
    expect(unknown.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Citation is not present in the Evidence Ledger"),
        expect.stringContaining("primary source or two independent"),
      ]),
    );
    expect(validateResearchReport("", ledger).diagnostics).toContain(
      "Research report does not cite its recorded evidence.",
    );
    expect(validateResearchReport("Malformed citation http://%", ledger).diagnostics).toContain(
      "Research report does not cite its recorded evidence.",
    );
  });

  it("accepts two independently corroborating non-primary domains", () => {
    const ledger = new EvidenceLedger();
    for (const [title, url] of [
      ["First", "https://first.example/a"],
      ["Second", "https://second.test/b"],
    ] as const) {
      ledger.record({
        claims: ["Shared claim"],
        sourceType: "independent",
        title,
        url,
        verification: "corroborated",
      });
    }

    const result = validateResearchReport(
      ["[First](https://first.example/a)", "[Second](https://second.test/b)"].join("\n"),
      ledger,
    );
    expect(result.passed).toBe(true);
    expect(result.primarySourceCount).toBe(0);
  });

  it("calculates deterministic claim, authority, freshness, diversity, and contradiction metrics", () => {
    const ledger = new EvidenceLedger();
    const primary = ledger.record({
      claims: ["The API was released."],
      publishedAt: "2026-08-01T00:00:00.000Z",
      sourceType: "primary",
      title: "Official",
      url: "https://official.example/release",
      verification: "corroborated",
    });
    const independent = ledger.record({
      claims: ["An independent source disputes the date."],
      publishedAt: "2026-08-02T00:00:00.000Z",
      sourceType: "independent",
      title: "Independent",
      url: "https://independent.test/report",
      verification: "corroborated",
    });
    const claims = new ResearchClaimLedger({ evidenceLedger: ledger });
    const first = claims.record({
      citationUrls: [primary.url],
      evidenceIds: [primary.id],
      statement: "The API was released.",
      temporal: true,
    });
    claims.record({
      citationUrls: [independent.url],
      contradictsClaimIds: [first.id],
      evidenceIds: [independent.id],
      statement: "An independent source disputes the date.",
      temporal: true,
    });
    const report = [
      "The API was released. https://official.example/release",
      "An independent source disputes the date. https://independent.test/report",
    ].join("\n\n");
    const result = validateResearchReport(report, ledger, claims, {
      freshnessDays: 30,
      minimumIndependentDomains: 2,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      citationPrecision: 1,
      citationRecall: 1,
      claimCount: 2,
      contradictionCoverage: 1,
      diversityScore: 1,
      freshnessScore: 1,
      passed: true,
      sourceAuthorityScore: 0.9,
      unsupportedClaimCount: 0,
    });
  });

  it("reports unsupported and stale structured claims", () => {
    const ledger = new EvidenceLedger();
    const evidence = ledger.record({
      claims: ["A stale claim."],
      publishedAt: "2020-01-01T00:00:00.000Z",
      sourceType: "primary",
      title: "Old source",
      url: "https://example.com/old",
      verification: "single-source",
    });
    const claims = new ResearchClaimLedger({ evidenceLedger: ledger });
    claims.record({
      citationUrls: [evidence.url],
      evidenceIds: [evidence.id],
      statement: "A stale claim.",
      temporal: true,
    });
    const result = validateResearchReport("A stale claim.", ledger, claims, {
      freshnessDays: 30,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(result.passed).toBe(false);
    expect(result).toMatchObject({
      citationPrecision: 0,
      citationRecall: 0,
      freshnessScore: 0,
      unsupportedClaimCount: 1,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unsupported structured claim"),
        expect.stringContaining("fresh evidence"),
      ]),
    );
  });

  it("reports empty Claim Manifests and validates metric configuration", () => {
    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });
    const claims = new ResearchClaimLedger({ evidenceLedger: ledger });
    const emptyManifest = validateResearchReport(
      "Claim https://example.com/source",
      ledger,
      claims,
    );
    expect(emptyManifest).toMatchObject({
      citationPrecision: 1,
      citationRecall: 1,
      claimCount: 0,
      passed: false,
    });
    expect(emptyManifest.diagnostics).toContain(
      "Research report has no structured Claim Manifest.",
    );

    for (const options of [
      { freshnessDays: 0 },
      { minimumIndependentDomains: 0 },
      { freshnessDays: 1.5 },
    ]) {
      expect(() =>
        validateResearchReport("Claim https://example.com/source", ledger, claims, options),
      ).toThrow("positive integer");
    }
  });

  it("scores secondary authority, undated temporal evidence, and omitted contradictions", () => {
    const ledger = new EvidenceLedger();
    const firstEvidence = ledger.record({
      claims: ["First claim."],
      sourceType: "secondary",
      title: "First",
      url: "http://localhost/first",
      verification: "corroborated",
    });
    const secondEvidence = ledger.record({
      claims: ["Second claim."],
      publishedAt: "2026-08-01T00:00:00.000Z",
      sourceType: "independent",
      title: "Second",
      url: "https://other.test/second",
      verification: "corroborated",
    });
    const claims = new ResearchClaimLedger({ evidenceLedger: ledger });
    const first = claims.record({
      citationUrls: [firstEvidence.url],
      evidenceIds: [firstEvidence.id],
      statement: "First claim.",
      temporal: true,
    });
    claims.record({
      citationUrls: [secondEvidence.url],
      contradictsClaimIds: [first.id],
      evidenceIds: [secondEvidence.id],
      statement: "Second claim.",
      temporal: false,
    });
    const result = validateResearchReport(
      "Second claim. https://other.test/second",
      ledger,
      claims,
      {
        freshnessDays: 30,
        minimumIndependentDomains: 2,
        now: new Date("2026-08-13T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      contradictionCoverage: 0,
      diversityScore: 0.5,
      freshnessScore: 0,
      sourceAuthorityScore: 0.8,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fresh evidence"),
        expect.stringContaining("recorded contradiction"),
      ]),
    );
  });
});
