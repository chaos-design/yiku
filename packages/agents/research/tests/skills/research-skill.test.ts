import type { HostedTool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/evidence-ledger.js";
import { createResearchSkill } from "../../src/skills/research-skill.js";

describe("createResearchSkill", () => {
  it("combines Web Search and Evidence Ledger tools", () => {
    const created = createResearchSkill({ searchContextSize: "high" });

    expect(created.skill).toMatchObject({
      description: expect.stringContaining("Evidence"),
      name: "research",
    });
    expect(created.skill.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "recordEvidenceTool",
      "recordResearchClaimTool",
    ]);
    expect((created.skill.tools[0] as HostedTool).providerData).toMatchObject({
      search_context_size: "high",
    });
    expect(created.ledger.snapshot()).toEqual([]);
    expect(created.claimLedger.snapshot()).toEqual([]);
  });

  it("reuses an injected Ledger and custom instructions with default search size", () => {
    const ledger = new EvidenceLedger();
    const created = createResearchSkill({
      instructions: "Use primary sources.",
      ledger,
    });

    expect(created.ledger).toBe(ledger);
    expect(created.skill.instructions).toBe("Use primary sources.");
    expect(created.skill.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "recordEvidenceTool",
      "recordResearchClaimTool",
    ]);
    expect((created.skill.tools[0] as HostedTool).providerData).not.toHaveProperty(
      "search_context_size",
    );
  });

  it("forwards Ledger limits and clocks when constructing the default Ledger", () => {
    const created = createResearchSkill({
      maxEvidence: 1,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    const evidence = created.ledger.record({
      claims: ["Claim"],
      sourceType: "primary",
      title: "Source",
      url: "https://example.com/source",
      verification: "corroborated",
    });

    expect(evidence.accessedAt).toBe("2026-08-08T00:00:00.000Z");
    expect(() =>
      created.ledger.record({
        claims: ["Second"],
        sourceType: "secondary",
        title: "Second source",
        url: "https://example.org/source",
        verification: "unverified",
      }),
    ).toThrow("Evidence limit");
  });
});
