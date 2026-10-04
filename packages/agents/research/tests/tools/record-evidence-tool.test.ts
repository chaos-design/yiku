import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";
import { recordEvidenceTool } from "../../src/tools/record-evidence-tool.js";

describe("recordEvidenceTool", () => {
  it("records validated evidence and returns a structured summary", async () => {
    const ledger = new EvidenceLedger({
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    const tool = recordEvidenceTool({ ledger });

    const output = await tool.invoke(
      {} as never,
      JSON.stringify({
        claims: ["The API was released in 2026."],
        published_at: "2026-08-01",
        source_type: "primary",
        title: "Official release",
        url: "https://example.com/release",
        verification: "single-source",
      }),
    );

    expect(JSON.parse(String(output))).toMatchObject({
      claims: 1,
      evidenceId: expect.any(String),
      sourceType: "primary",
      url: "https://example.com/release",
    });
    expect(ledger.snapshot()).toHaveLength(1);
  });

  it("returns model-readable validation errors", async () => {
    const tool = recordEvidenceTool({ ledger: new EvidenceLedger() });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          claims: [],
          source_type: "primary",
          title: "",
          url: "file:///tmp/source",
          verification: "unverified",
        }),
      ),
    ).resolves.toContain("Error:");
  });

  it("records evidence without an optional publication date", async () => {
    const ledger = new EvidenceLedger();
    const tool = recordEvidenceTool({ ledger });

    await tool.invoke(
      {} as never,
      JSON.stringify({
        claims: ["The API is available."],
        source_type: "independent",
        title: "Independent report",
        url: "https://independent.example/report",
        verification: "corroborated",
      }),
    );

    expect(ledger.snapshot()[0]?.publishedAt).toBeUndefined();
  });

  it("formats non-Error Ledger failures for the model", async () => {
    const ledger = {
      record: () => {
        throw "ledger unavailable";
      },
    } as unknown as EvidenceLedger;
    const tool = recordEvidenceTool({ ledger });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          claims: ["Claim"],
          source_type: "primary",
          title: "Source",
          url: "https://example.com/source",
          verification: "unverified",
        }),
      ),
    ).resolves.toBe("Error: ledger unavailable");
  });
});
