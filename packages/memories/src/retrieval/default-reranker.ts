import { MemoryEmbeddingError } from "../errors.js";
import type {
  MemoryCandidateSet,
  MemoryPolicy,
  MemoryRecallReason,
  MemoryRecallResult,
  MemoryRecord,
  MemoryReranker,
  MemoryRerankInput,
  RankedStoredMemory,
  StoredMemory,
} from "../types.js";

interface CombinedCandidate {
  readonly lexical?: RankedStoredMemory | undefined;
  readonly memory: StoredMemory;
  readonly vector?: RankedStoredMemory | undefined;
}

export class DefaultMemoryReranker implements MemoryReranker {
  public rerank(input: MemoryRerankInput): readonly MemoryRecallResult[] {
    const candidates = combineCandidates(input.candidates)
      .map((candidate) => scoreCandidate(candidate, input.now, input.policy))
      .sort(compareResults);
    const fingerprints = new Set<string>();
    const kindCounts = new Map<string, number>();
    const results: MemoryRecallResult[] = [];
    let contentChars = 0;

    for (const candidate of candidates) {
      const fingerprint = candidate.internal.fingerprint;
      const kindCount = kindCounts.get(candidate.memory.kind) ?? 0;

      if (
        fingerprints.has(fingerprint) ||
        kindCount >= input.kindResultLimit ||
        results.length >= input.limit
      ) {
        continue;
      }

      if (contentChars + candidate.memory.content.length > input.maxChars) {
        continue;
      }

      fingerprints.add(fingerprint);
      kindCounts.set(candidate.memory.kind, kindCount + 1);
      contentChars += candidate.memory.content.length;
      results.push({
        memory: candidate.memory,
        reasons: candidate.reasons,
        score: candidate.score,
        scores: candidate.scores,
      });
    }

    return results;
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new MemoryEmbeddingError(
      "MEMORY_EMBEDDING_INVALID",
      "Embedding vectors must have equal non-zero dimensions.",
    );
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];

    if (
      leftValue === undefined ||
      rightValue === undefined ||
      !Number.isFinite(leftValue) ||
      !Number.isFinite(rightValue)
    ) {
      throw new MemoryEmbeddingError(
        "MEMORY_EMBEDDING_INVALID",
        "Embedding vectors must contain only finite numbers.",
      );
    }

    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    throw new MemoryEmbeddingError(
      "MEMORY_EMBEDDING_INVALID",
      "Embedding vectors must have non-zero magnitude.",
    );
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function combineCandidates(candidates: MemoryCandidateSet): readonly CombinedCandidate[] {
  const combined = new Map<string, CombinedCandidate>();

  for (const lexical of candidates.lexical) {
    combined.set(lexical.memory.id, {
      lexical,
      memory: lexical.memory,
    });
  }

  for (const vector of candidates.vector) {
    const current = combined.get(vector.memory.id);
    combined.set(vector.memory.id, {
      ...(current?.lexical !== undefined ? { lexical: current.lexical } : {}),
      memory: vector.memory,
      vector,
    });
  }

  return [...combined.values()];
}

function scoreCandidate(
  candidate: CombinedCandidate,
  now: string,
  policy: MemoryPolicy,
): MemoryRecallResult & { readonly internal: StoredMemory } {
  const lexicalRetrieval =
    candidate.lexical === undefined ? 0 : 1 / (policy.rrfConstant + candidate.lexical.rank);
  const vectorRetrieval =
    candidate.vector === undefined ? 0 : 1 / (policy.rrfConstant + candidate.vector.rank);
  const quality = 0.5 + 0.25 * candidate.memory.confidence + 0.25 * candidate.memory.importance;
  const ageDays = Math.max(
    0,
    (Date.parse(now) - Date.parse(candidate.memory.updatedAt)) / 86_400_000,
  );
  const recency = 0.9 + 0.1 * Math.exp(-ageDays / policy.recencyHalfLifeDays);
  const access =
    1 / (1 + policy.accessDecay * Math.log1p(Math.max(0, candidate.memory.accessCount)));
  const reasons: MemoryRecallReason[] = [];

  if (candidate.lexical !== undefined) {
    reasons.push("LEXICAL_MATCH");
  }
  if (candidate.vector !== undefined) {
    reasons.push("SEMANTIC_MATCH");
  }
  if (candidate.memory.confidence >= 0.75) {
    reasons.push("HIGH_CONFIDENCE");
  }
  if (candidate.memory.importance >= 0.75) {
    reasons.push("HIGH_IMPORTANCE");
  }
  if (ageDays <= policy.recencyHalfLifeDays) {
    reasons.push("RECENT");
  }

  return {
    internal: candidate.memory,
    memory: toMemoryRecord(candidate.memory),
    reasons,
    score: (lexicalRetrieval + vectorRetrieval) * quality * recency * access,
    scores: {
      access,
      ...(candidate.lexical !== undefined ? { lexical: candidate.lexical.score } : {}),
      quality,
      recency,
      ...(candidate.vector !== undefined ? { vector: candidate.vector.score } : {}),
    },
  };
}

function compareResults(
  left: MemoryRecallResult & { readonly internal: StoredMemory },
  right: MemoryRecallResult & { readonly internal: StoredMemory },
): number {
  return (
    right.score - left.score ||
    right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
    left.memory.id.localeCompare(right.memory.id)
  );
}

export function toMemoryRecord(memory: StoredMemory): MemoryRecord {
  return {
    accessCount: memory.accessCount,
    confidence: memory.confidence,
    content: memory.content,
    createdAt: memory.createdAt,
    ...(memory.expiresAt !== undefined ? { expiresAt: memory.expiresAt } : {}),
    id: memory.id,
    importance: memory.importance,
    kind: memory.kind,
    ...(memory.lastAccessedAt !== undefined ? { lastAccessedAt: memory.lastAccessedAt } : {}),
    metadata: memory.metadata,
    namespace: memory.namespace,
    revision: memory.revision,
    scope: memory.scope,
    source: memory.source,
    status: memory.status,
    tags: memory.tags,
    updatedAt: memory.updatedAt,
  };
}
