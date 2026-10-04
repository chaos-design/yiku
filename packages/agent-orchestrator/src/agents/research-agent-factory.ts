import type { Tool } from "@openai/agents";
import {
  createResearchEvaluators,
  createResearchSkill,
  ResearchAgent,
  type ResearchClaim,
  type ResearchEvidence,
  type ResearchManifest,
  researchEvidenceArtifacts,
  researchReportArtifact,
  type SearchContextSize,
  validateResearchReport,
} from "@yiku/agent-research";
import { ResearchRunObserver } from "./research-run-observer.js";
import type { AgentFactory, AgentFactoryInput, AgentFactoryResult } from "./types.js";

export interface ResearchAgentFactoryResult extends AgentFactoryResult {
  readonly claimManifest: (report: string) => ResearchManifest;
  readonly claimSnapshot: () => readonly ResearchClaim[];
  readonly evidenceSnapshot: () => readonly ResearchEvidence[];
}

export interface ResearchAgentFactoryOptions {
  readonly searchContextSize?: SearchContextSize | undefined;
}

export class ResearchAgentFactory implements AgentFactory<ResearchAgentFactoryResult> {
  public readonly type = "research";

  public constructor(private readonly options: ResearchAgentFactoryOptions = {}) {}

  public create(input: AgentFactoryInput): ResearchAgentFactoryResult {
    const created = createResearchSkill({
      ...(this.options.searchContextSize !== undefined
        ? { searchContextSize: this.options.searchContextSize }
        : {}),
    });
    const tools = mergeTools(created.skill.tools, input.tools);
    const instructions = [created.skill.instructions, input.instructions?.trim()]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    return {
      agent: new ResearchAgent({
        agentName: input.agentName,
        handoffs: input.handoffs,
        instructions,
        model: input.model,
        tools,
      }),
      createRunObserver: (context) =>
        new ResearchRunObserver({
          context,
          ledger: created.ledger,
        }),
      claimManifest: (report) => created.claimLedger.manifest(report),
      claimSnapshot: () => created.claimLedger.snapshot(),
      evidenceSnapshot: () => created.ledger.snapshot(),
      evaluationProvider: {
        createEvaluators: (config = {}) =>
          createResearchEvaluators(created.ledger, created.claimLedger, {
            ...(typeof config.freshnessDays === "number"
              ? { freshnessDays: config.freshnessDays }
              : {}),
            ...(typeof config.minimumIndependentDomains === "number"
              ? {
                  minimumIndependentDomains: config.minimumIndependentDomains,
                }
              : {}),
          }),
        snapshot: (finalOutput) => {
          const manifest = created.claimLedger.manifest(finalOutput);
          return {
            artifacts: Object.freeze([
              ...researchEvidenceArtifacts(created.ledger),
              researchReportArtifact(finalOutput),
              Object.freeze({
                digest: manifest.digest,
                id: `research-claim-${manifest.digest}`,
                kind: "research-claim" as const,
                metadata: Object.freeze({
                  claims: manifest.claims.length,
                  reportDigest: manifest.reportDigest,
                }),
                sizeBytes: Buffer.byteLength(JSON.stringify(manifest), "utf8"),
                storageRef: `research:claim-manifest:${manifest.digest}`,
              }),
            ]),
            researchClaimManifest: manifest,
          };
        },
      },
      validateOutput: async (output) => {
        const validation = validateResearchReport(
          typeof output === "string" ? output : String(output ?? ""),
          created.ledger,
        );
        return {
          details: validation,
          diagnostics: validation.diagnostics,
          passed: validation.passed,
        };
      },
    };
  }
}

function mergeTools(domainTools: readonly Tool[], hostTools: readonly Tool[]): readonly Tool[] {
  const tools = [...domainTools, ...hostTools];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}.`);
    }
    names.add(tool.name);
  }
  return Object.freeze(tools);
}
