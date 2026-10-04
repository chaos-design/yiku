import { ResearchClaimLedger, type ResearchClaimLedgerOptions } from "../evidence/claim-ledger.js";
import { EvidenceLedger, type EvidenceLedgerOptions } from "../evidence/evidence-ledger.js";
import type { SearchContextSize } from "../models/research-agent.js";
import { DEFAULT_RESEARCH_PROMPT } from "../prompts/research-prompt.js";
import { recordClaimTool } from "../tools/record-claim-tool.js";
import { recordEvidenceTool } from "../tools/record-evidence-tool.js";
import { createResearchWebSearchTool } from "../tools/web-search-tool.js";
import type { ResearchSkill } from "./types.js";

export interface CreateResearchSkillOptions extends EvidenceLedgerOptions {
  readonly claimLedger?: ResearchClaimLedger | undefined;
  readonly instructions?: string | undefined;
  readonly ledger?: EvidenceLedger | undefined;
  readonly maxClaims?: number | undefined;
  readonly onClaim?: ResearchClaimLedgerOptions["onRecord"];
  readonly searchContextSize?: SearchContextSize | undefined;
}

export function createResearchSkill(options: CreateResearchSkillOptions = {}): {
  readonly claimLedger: ResearchClaimLedger;
  readonly ledger: EvidenceLedger;
  readonly skill: ResearchSkill;
} {
  const ledger =
    options.ledger ??
    new EvidenceLedger({
      ...(options.maxEvidence !== undefined ? { maxEvidence: options.maxEvidence } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.onRecord !== undefined ? { onRecord: options.onRecord } : {}),
    });
  const claimLedger =
    options.claimLedger ??
    new ResearchClaimLedger({
      evidenceLedger: ledger,
      ...(options.maxClaims !== undefined ? { maxClaims: options.maxClaims } : {}),
      ...(options.onClaim !== undefined ? { onRecord: options.onClaim } : {}),
    });
  return Object.freeze({
    claimLedger,
    ledger,
    skill: Object.freeze({
      description: "Evidence-led live web research with source validation.",
      instructions: options.instructions?.trim() || DEFAULT_RESEARCH_PROMPT,
      name: "research",
      tools: Object.freeze([
        createResearchWebSearchTool(options.searchContextSize),
        recordEvidenceTool({ ledger }),
        recordClaimTool({ ledger: claimLedger }),
      ]),
    }),
  });
}
