import { describe, expect, it } from "vitest";
import { ResearchClaimLedger } from "../../src/evidence/claim-ledger.js";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";
import { recordClaimTool } from "../../src/tools/record-claim-tool.js";

describe("recordClaimTool", () => {
  it("records a structured claim and returns a bounded summary", async () => {
    const evidenceLedger = new EvidenceLedger();
    const evidence = evidenceLedger.record({
      claims: ["The API is available."],
      sourceType: "primary",
      title: "Official",
      url: "https://example.com/release",
      verification: "single-source",
    });
    const ledger = new ResearchClaimLedger({ evidenceLedger });
    const tool = recordClaimTool({ ledger });
    const output = await tool.invoke(
      {} as never,
      JSON.stringify({
        citation_urls: [evidence.url],
        evidence_ids: [evidence.id],
        statement: "The API is available.",
        temporal: false,
      }),
    );

    expect(JSON.parse(String(output))).toMatchObject({
      claimId: expect.any(String),
      citations: 1,
      evidence: 1,
      temporal: false,
    });
    expect(ledger.snapshot()).toHaveLength(1);

    const firstClaimId = ledger.snapshot()[0]?.id;
    if (firstClaimId === undefined) {
      throw new Error("Expected the first claim.");
    }
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          citation_urls: [evidence.url],
          contradicts_claim_ids: [firstClaimId],
          evidence_ids: [evidence.id],
          statement: "The API availability is disputed.",
          temporal: false,
        }),
      ),
    ).resolves.toContain("claimId");
    expect(ledger.snapshot()[1]?.contradictsClaimIds).toEqual([firstClaimId]);
  });

  it("returns model-readable validation errors", async () => {
    const ledger = new ResearchClaimLedger({
      evidenceLedger: new EvidenceLedger(),
    });
    const tool = recordClaimTool({ ledger });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          citation_urls: ["https://example.com"],
          evidence_ids: ["missing"],
          statement: "Unsupported.",
          temporal: false,
        }),
      ),
    ).resolves.toContain("Error:");
  });

  it("formats non-Error Ledger failures for model consumption", async () => {
    const tool = recordClaimTool({
      ledger: {
        record() {
          throw "ledger unavailable";
        },
      } as unknown as ResearchClaimLedger,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          citation_urls: ["https://example.com"],
          evidence_ids: ["evidence"],
          statement: "Claim.",
          temporal: false,
        }),
      ),
    ).resolves.toBe("Error: ledger unavailable");
  });
});
