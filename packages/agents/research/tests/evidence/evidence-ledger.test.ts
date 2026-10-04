import { describe, expect, it, vi } from "vitest";
import { canonicalResearchUrl, EvidenceLedger } from "../../src/evidence/evidence-ledger.js";

describe("EvidenceLedger", () => {
  it("canonicalizes URLs and merges duplicate evidence", () => {
    const ledger = new EvidenceLedger({
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    const first = ledger.record({
      claims: ["Claim A"],
      sourceType: "secondary",
      title: "Example",
      url: "HTTPS://Example.COM:443/report?b=2&a=1#section",
      verification: "single-source",
    });
    const merged = ledger.record({
      claims: ["Claim B", "Claim A"],
      publishedAt: "2026-08-01T00:00:00.000Z",
      sourceType: "primary",
      title: "Example report",
      url: "https://example.com/report?a=1&b=2",
      verification: "corroborated",
    });

    expect(merged.id).toBe(first.id);
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({
        claims: ["Claim A", "Claim B"],
        publishedAt: "2026-08-01T00:00:00.000Z",
        sourceType: "primary",
        url: "https://example.com/report?a=1&b=2",
        verification: "corroborated",
      }),
    ]);
    expect(Object.isFrozen(ledger.snapshot())).toBe(true);
  });

  it("rejects unsupported URLs and invalid evidence", () => {
    const ledger = new EvidenceLedger();

    expect(() =>
      ledger.record({
        claims: ["Claim"],
        sourceType: "primary",
        title: "File",
        url: "file:///tmp/source",
        verification: "unverified",
      }),
    ).toThrow("Evidence URL must use HTTP or HTTPS");
    expect(() =>
      ledger.record({
        claims: [],
        sourceType: "primary",
        title: "",
        url: "https://example.com",
        verification: "unverified",
      }),
    ).toThrow();
  });

  it("enforces the unique evidence limit and reports independent domains", () => {
    const ledger = new EvidenceLedger({ maxEvidence: 2 });
    ledger.record({
      claims: ["A"],
      sourceType: "primary",
      title: "A",
      url: "https://docs.example.com/a",
      verification: "corroborated",
    });
    ledger.record({
      claims: ["B"],
      sourceType: "independent",
      title: "B",
      url: "https://news.other.org/b",
      verification: "corroborated",
    });

    expect(ledger.independentDomainCount()).toBe(2);
    expect(() =>
      ledger.record({
        claims: ["C"],
        sourceType: "secondary",
        title: "C",
        url: "https://third.test/c",
        verification: "unverified",
      }),
    ).toThrow("Evidence limit");
  });

  it("validates limits, dates, credentials, URLs, and bounded text", () => {
    expect(() => new EvidenceLedger({ maxEvidence: 0 })).toThrow("positive integer");
    expect(() => new EvidenceLedger({ maxEvidence: 1.5 })).toThrow("positive integer");
    const ledger = new EvidenceLedger();
    const draft = {
      claims: ["Claim"],
      sourceType: "secondary" as const,
      title: "Evidence",
      verification: "unverified" as const,
    };

    expect(() => ledger.record({ ...draft, claims: [], url: "https://example.com" })).toThrow(
      "at least one claim",
    );
    expect(() =>
      ledger.record({ ...draft, publishedAt: "invalid", url: "https://example.com" }),
    ).toThrow("publishedAt");
    expect(() => ledger.record({ ...draft, url: "not a URL" })).toThrow("must be valid");
    expect(() => ledger.record({ ...draft, url: "https://user:secret@example.com" })).toThrow(
      "must not contain credentials",
    );
    expect(() =>
      ledger.record({ ...draft, title: "x".repeat(1_001), url: "https://example.com" }),
    ).toThrow("at most 1000");
    expect(() =>
      ledger.record({
        ...draft,
        claims: ["x".repeat(4_097)],
        url: "https://example.com",
      }),
    ).toThrow("at most 4096");
    expect(canonicalResearchUrl("https://example.com/report?a=2&a=1")).toBe(
      "https://example.com/report?a=1&a=2",
    );
  });

  it("keeps stronger duplicate metadata and handles single-label domains", () => {
    const ledger = new EvidenceLedger();
    ledger.record({
      claims: ["Claim"],
      publishedAt: "2026-08-01",
      sourceType: "primary",
      title: "A longer evidence title",
      url: "http://localhost/report",
      verification: "corroborated",
    });
    const merged = ledger.record({
      claims: ["Claim"],
      sourceType: "secondary",
      title: "Short",
      url: "http://localhost/report",
      verification: "unverified",
    });

    expect(merged).toMatchObject({
      publishedAt: "2026-08-01T00:00:00.000Z",
      sourceType: "primary",
      title: "A longer evidence title",
      verification: "corroborated",
    });
    expect(ledger.independentDomainCount()).toBe(1);
  });

  it("notifies observers with immutable evidence without allowing observer failures to alter writes", () => {
    const onRecord = vi.fn(() => {
      throw new Error("observer failed");
    });
    const ledger = new EvidenceLedger({ onRecord });
    const listener = vi.fn();
    const unsubscribe = ledger.subscribe(listener);
    const evidence = ledger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "single-source",
    });

    expect(onRecord).toHaveBeenCalledWith(evidence);
    expect(listener).toHaveBeenCalledWith(evidence);
    expect(ledger.snapshot()).toEqual([evidence]);
    expect(Object.isFrozen(evidence)).toBe(true);

    unsubscribe();
    unsubscribe();
    ledger.record({
      claims: ["Second"],
      sourceType: "secondary",
      title: "Second source",
      url: "https://example.com/second",
      verification: "unverified",
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});
