import { tool } from "@openai/agents";
import { z } from "zod";
import type { ResearchClaimLedger } from "../evidence/claim-ledger.js";

const recordClaimInputSchema = z
  .object({
    citation_urls: z.array(z.string().trim().min(1).max(4_096)).min(1).max(20),
    contradicts_claim_ids: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    evidence_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
    statement: z.string().trim().min(1).max(4_096),
    temporal: z.boolean(),
  })
  .strict();

export interface RecordClaimToolOptions {
  readonly ledger: ResearchClaimLedger;
}

export function recordClaimTool(options: RecordClaimToolOptions) {
  return tool({
    description:
      "Record a final report claim with its Evidence Ledger IDs and exact citation URLs.",
    errorFunction: (_context: unknown, error: unknown) =>
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    execute: async (input: z.infer<typeof recordClaimInputSchema>) => {
      const claim = options.ledger.record({
        citationUrls: input.citation_urls,
        ...(input.contradicts_claim_ids !== undefined
          ? { contradictsClaimIds: input.contradicts_claim_ids }
          : {}),
        evidenceIds: input.evidence_ids,
        statement: input.statement,
        temporal: input.temporal,
      });
      return JSON.stringify({
        claimId: claim.id,
        citations: claim.citationUrls.length,
        evidence: claim.evidenceIds.length,
        temporal: claim.temporal,
      });
    },
    name: "recordResearchClaimTool",
    parameters: recordClaimInputSchema,
    strict: true,
  });
}
