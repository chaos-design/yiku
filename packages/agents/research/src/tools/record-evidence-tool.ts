import { tool } from "@openai/agents";
import { z } from "zod";
import type { EvidenceLedger } from "../evidence/evidence-ledger.js";

const recordEvidenceInputSchema = z
  .object({
    claims: z.array(z.string().trim().min(1).max(4_096)).min(1).max(20),
    published_at: z.string().trim().min(1).optional(),
    source_type: z.enum(["independent", "primary", "secondary"]),
    title: z.string().trim().min(1).max(1_000),
    url: z.string().trim().min(1).max(4_096),
    verification: z.enum(["corroborated", "single-source", "unverified"]),
  })
  .strict();

export interface RecordEvidenceToolOptions {
  readonly ledger: EvidenceLedger;
}

export function recordEvidenceTool(options: RecordEvidenceToolOptions) {
  return tool({
    description:
      "Record a source and the claims it supports in the current Research Evidence Ledger.",
    errorFunction: (_context: unknown, error: unknown) =>
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    execute: async (input: z.infer<typeof recordEvidenceInputSchema>) => {
      const evidence = options.ledger.record({
        claims: input.claims,
        ...(input.published_at !== undefined ? { publishedAt: input.published_at } : {}),
        sourceType: input.source_type,
        title: input.title,
        url: input.url,
        verification: input.verification,
      });
      return JSON.stringify({
        claims: evidence.claims.length,
        evidenceId: evidence.id,
        sourceType: evidence.sourceType,
        url: evidence.url,
        verification: evidence.verification,
      });
    },
    name: "recordEvidenceTool",
    parameters: recordEvidenceInputSchema,
    strict: true,
  });
}
