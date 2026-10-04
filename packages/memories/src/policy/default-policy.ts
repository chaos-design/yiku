import type { MemoryPolicy } from "../types.js";

export const DEFAULT_MEMORY_POLICY = Object.freeze({
  accessDecay: 0.08,
  defaultRecallLimit: 10,
  defaultRecallMaxChars: 8_000,
  defaultRetentionMs: {},
  embeddingBatchSize: 32,
  embeddingFailureMode: "lexical",
  extractedConfidenceThreshold: 0.55,
  kindResultLimit: 4,
  lexicalCandidateLimit: 50,
  maxBatchSize: 100,
  maxContentBytes: 32_768,
  maxMetadataBytes: 16_384,
  maxMetadataDepth: 8,
  maxRecallLimit: 100,
  maxRecallMaxChars: 65_536,
  maxScopeValueBytes: 256,
  maxTagBytes: 128,
  maxTags: 32,
  maxVectorScan: 2_000,
  namespaceMaxBytes: 256,
  recencyHalfLifeDays: 30,
  rrfConstant: 60,
  vectorCandidateLimit: 50,
} satisfies MemoryPolicy);

export class DefaultMemoryPolicy implements MemoryPolicy {
  public readonly accessDecay!: number;
  public readonly defaultRecallLimit!: number;
  public readonly defaultRecallMaxChars!: number;
  public readonly defaultRetentionMs!: MemoryPolicy["defaultRetentionMs"];
  public readonly embeddingBatchSize!: number;
  public readonly embeddingFailureMode!: MemoryPolicy["embeddingFailureMode"];
  public readonly extractedConfidenceThreshold!: number;
  public readonly kindResultLimit!: number;
  public readonly lexicalCandidateLimit!: number;
  public readonly maxBatchSize!: number;
  public readonly maxContentBytes!: number;
  public readonly maxMetadataBytes!: number;
  public readonly maxMetadataDepth!: number;
  public readonly maxRecallLimit!: number;
  public readonly maxRecallMaxChars!: number;
  public readonly maxScopeValueBytes!: number;
  public readonly maxTagBytes!: number;
  public readonly maxTags!: number;
  public readonly maxVectorScan!: number;
  public readonly namespaceMaxBytes!: number;
  public readonly recencyHalfLifeDays!: number;
  public readonly rrfConstant!: number;
  public readonly vectorCandidateLimit!: number;

  public constructor(overrides: Partial<MemoryPolicy> = {}) {
    Object.assign(this, DEFAULT_MEMORY_POLICY, overrides);
    Object.freeze(this);
  }
}
