import type { AtomicFlowRun } from "@yiku/atomic-flow";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type MemoryClass = "procedure" | "scenario" | "semantic";
export type MemorySearchClass = MemoryClass | "working";
export type MemoryKind = "decision" | "episode" | "fact" | "preference" | "procedure";
export type MemoryStatus = "active" | "deleted";
export type MemorySourceType = "import" | "session" | "tool" | "user";
export type WorkingMemorySource = "operation" | "prompt" | "task" | "turn-extract" | "user-answer";
export type WorkingMemoryStatus = "active" | "consolidated" | "discarded";
export type MemoryForgetMode = "hard" | "soft";
export type MemoryEmbeddingFailureMode = "error" | "lexical";
export type MemoryOperation =
  | "capture"
  | "consolidate"
  | "extract"
  | "forget"
  | "ingest"
  | "initialize"
  | "prune"
  | "recall"
  | "remember"
  | "search"
  | "update";
export type MemoryOperationPhase = "end" | "error" | "start";
export type MemoryRecallReason =
  | "HIGH_CONFIDENCE"
  | "HIGH_IMPORTANCE"
  | "LEXICAL_MATCH"
  | "RECENT"
  | "SEMANTIC_MATCH";

export interface MemoryScope {
  readonly agentId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly userId?: string | undefined;
}

export interface MemoryContext {
  readonly namespace: string;
  readonly scope?: MemoryScope | undefined;
}

export interface MemorySource {
  readonly id?: string | undefined;
  readonly type: MemorySourceType;
}

export interface MemoryRecord {
  readonly accessCount: number;
  readonly confidence: number;
  readonly content: string;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
  readonly id: string;
  readonly importance: number;
  readonly kind: MemoryKind;
  readonly lastAccessedAt?: string | undefined;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly namespace: string;
  readonly revision: number;
  readonly scope: MemoryScope;
  readonly source: MemorySource;
  readonly status: MemoryStatus;
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

export interface MemoryDraft {
  readonly confidence: number;
  readonly content: string;
  readonly expiresAt?: string | undefined;
  readonly importance: number;
  readonly kind: MemoryKind;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface WorkingMemoryRecord {
  readonly consolidatedAt?: string | undefined;
  readonly content: string;
  readonly createdAt: string;
  readonly draft?: MemoryDraft | undefined;
  readonly id: string;
  readonly longTermMemoryId?: string | undefined;
  readonly sessionId: string;
  readonly source: WorkingMemorySource;
  readonly status: WorkingMemoryStatus;
  readonly updatedAt: string;
}

export interface WorkingMemoryStore {
  list(sessionId: string): Promise<readonly WorkingMemoryRecord[]>;
  replace(
    sessionId: string,
    records: readonly WorkingMemoryRecord[],
  ): Promise<readonly WorkingMemoryRecord[]>;
}

export interface MemoryExtractionInput {
  readonly agentId?: string | undefined;
  readonly context: MemoryContext;
  readonly output: string;
  readonly projectId?: string | undefined;
  readonly prompt: string;
  readonly sessionId: string;
  readonly userId?: string | undefined;
  readonly workingMemories?: readonly WorkingMemoryRecord[] | undefined;
}

export interface MemoryOperationOptions {
  readonly atomicFlow?: AtomicFlowRun | undefined;
  readonly atomicParentInstanceId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface MemoryExtractor {
  extract(
    input: MemoryExtractionInput,
    options?: MemoryOperationOptions,
  ): Promise<readonly MemoryDraft[]>;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  embed(
    texts: readonly string[],
    options?: MemoryOperationOptions,
  ): Promise<readonly (readonly number[])[]>;
}

export interface MemoryRedactor {
  readonly name: string;
  redact(content: string): string;
}

export interface MemoryPolicy {
  readonly accessDecay: number;
  readonly defaultRecallLimit: number;
  readonly defaultRecallMaxChars: number;
  readonly defaultRetentionMs: Readonly<Partial<Record<MemoryKind, number>>>;
  readonly embeddingBatchSize: number;
  readonly embeddingFailureMode: MemoryEmbeddingFailureMode;
  readonly extractedConfidenceThreshold: number;
  readonly kindResultLimit: number;
  readonly lexicalCandidateLimit: number;
  readonly maxBatchSize: number;
  readonly maxContentBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxMetadataDepth: number;
  readonly maxRecallLimit: number;
  readonly maxRecallMaxChars: number;
  readonly maxScopeValueBytes: number;
  readonly maxTagBytes: number;
  readonly maxTags: number;
  readonly maxVectorScan: number;
  readonly namespaceMaxBytes: number;
  readonly recencyHalfLifeDays: number;
  readonly rrfConstant: number;
  readonly vectorCandidateLimit: number;
}

export interface MemoryClock {
  now(): Date;
}

export interface MemoryEmbedding {
  readonly dimensions: number;
  readonly model: string;
  readonly values: readonly number[];
}

export interface StoredMemory extends MemoryRecord {
  readonly embedding?: MemoryEmbedding | undefined;
  readonly fingerprint: string;
  readonly idempotencyHash?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly normalizedContent: string;
  readonly scopeKey: string;
}

export interface StoredMemoryWrite extends StoredMemory {}

export interface RememberMemoryInput extends MemoryOperationOptions {
  readonly confidence?: number | undefined;
  readonly content: string;
  readonly context: MemoryContext;
  readonly expiresAt?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly importance?: number | undefined;
  readonly kind: MemoryKind;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly source?: MemorySource | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface IngestSessionInput extends MemoryExtractionInput, MemoryOperationOptions {}

export interface IngestSessionResult {
  readonly discarded: number;
  readonly extracted: number;
  readonly memories: readonly MemoryRecord[];
}

export interface ExtractSessionInput extends MemoryExtractionInput, MemoryOperationOptions {}

export interface ExtractSessionResult {
  readonly discarded: number;
  readonly drafts: readonly MemoryDraft[];
  readonly extracted: number;
}

export interface RecallMemoryInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly kinds?: readonly MemoryKind[] | undefined;
  readonly limit?: number | undefined;
  readonly maxChars?: number | undefined;
  readonly query: string;
  readonly tags?: readonly string[] | undefined;
}

export interface SearchLongTermMemoryInput extends RecallMemoryInput {}

export interface CaptureWorkingMemoryInput extends MemoryOperationOptions {
  readonly content: string;
  readonly draft?: MemoryDraft | undefined;
  readonly sessionId: string;
  readonly source: WorkingMemorySource;
}

export interface SearchMemoriesInput extends MemoryOperationOptions {
  readonly classes?: readonly MemorySearchClass[] | undefined;
  readonly context: MemoryContext;
  readonly limit?: number | undefined;
  readonly maxChars?: number | undefined;
  readonly query: string;
  readonly sessionId: string;
}

export interface WorkingMemorySearchResult {
  readonly class: "working";
  readonly content: string;
  readonly reasons: readonly ["WORKING_MATCH"];
  readonly score: number;
  readonly tier: "working";
  readonly workingMemory: WorkingMemoryRecord;
}

export interface LongTermMemorySearchResult {
  readonly class: MemoryClass;
  readonly content: string;
  readonly memory: MemoryRecord;
  readonly reasons: readonly MemoryRecallReason[];
  readonly score: number;
  readonly scores: MemoryRecallScores;
  readonly tier: "long-term";
}

export type MemorySearchResult = LongTermMemorySearchResult | WorkingMemorySearchResult;

export interface ConsolidateMemoriesInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly sessionId: string;
}

export interface ConsolidateMemoriesResult {
  readonly consolidated: number;
  readonly discarded: number;
  readonly failed: number;
  readonly memories: readonly MemoryRecord[];
  readonly pending: number;
}

export interface ForgetUnifiedMemoryInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly id: string;
  readonly mode?: MemoryForgetMode | undefined;
  readonly sessionId: string;
}

export interface ForgetUnifiedMemoryResult {
  readonly forgotten: boolean;
  readonly id: string;
  readonly mode: MemoryForgetMode;
  readonly tier?: "long-term" | "working" | undefined;
}

export interface MemoryClassCounts {
  readonly procedure: number;
  readonly scenario: number;
  readonly semantic: number;
}

export interface MemoryLifecycleStatus {
  readonly longTerm: MemoryClassCounts;
  readonly pendingConsolidation: number;
  readonly working: number;
}

export interface GetMemoryInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly id: string;
}

export interface UpdateMemoryPatch {
  readonly confidence?: number | undefined;
  readonly content?: string | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly importance?: number | undefined;
  readonly kind?: MemoryKind | undefined;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly source?: MemorySource | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface UpdateMemoryInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly expectedRevision: number;
  readonly id: string;
  readonly patch: UpdateMemoryPatch;
}

export interface ForgetMemoryInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly id: string;
  readonly mode?: MemoryForgetMode | undefined;
}

export interface PruneMemoriesInput extends MemoryOperationOptions {
  readonly before: string;
  readonly context: MemoryContext;
}

export interface PruneMemoriesResult {
  readonly deleted: number;
}

export interface RankedStoredMemory {
  readonly memory: StoredMemory;
  readonly rank: number;
  readonly score: number;
}

export interface MemoryCandidateSet {
  readonly lexical: readonly RankedStoredMemory[];
  readonly vector: readonly RankedStoredMemory[];
  readonly vectorScanExceeded: boolean;
}

export interface MemoryStoreSearchInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly embeddingModel?: string | undefined;
  readonly kinds?: readonly MemoryKind[] | undefined;
  readonly lexicalLimit: number;
  readonly now: string;
  readonly query: string;
  readonly queryEmbedding?: readonly number[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly vectorLimit: number;
  readonly vectorScanLimit: number;
}

export interface MemoryStoreGetInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly id: string;
}

export interface MemoryStoreUpdateInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly expectedRevision: number;
  readonly memory: StoredMemoryWrite;
}

export interface MemoryStoreTouchInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly ids: readonly string[];
  readonly touchedAt: string;
}

export interface MemoryStoreForgetInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly id: string;
  readonly mode: MemoryForgetMode;
  readonly updatedAt: string;
}

export interface MemoryStorePruneInput extends MemoryOperationOptions {
  readonly before: string;
  readonly context: MemoryContext;
  readonly now: string;
}

export interface MemoryStorePruneResult {
  readonly deleted: number;
}

export interface MemoryStoreCountInput extends MemoryOperationOptions {
  readonly context: MemoryContext;
  readonly now: string;
}

export type MemoryKindCounts = Readonly<Record<MemoryKind, number>>;

export interface MemoryStore {
  initialize(options?: MemoryOperationOptions): Promise<void>;
  rememberMany(
    inputs: readonly StoredMemoryWrite[],
    options?: MemoryOperationOptions,
  ): Promise<readonly StoredMemory[]>;
  get(input: MemoryStoreGetInput): Promise<StoredMemory | undefined>;
  update(input: MemoryStoreUpdateInput): Promise<StoredMemory>;
  search(input: MemoryStoreSearchInput): Promise<MemoryCandidateSet>;
  touch(input: MemoryStoreTouchInput): Promise<void>;
  forget(input: MemoryStoreForgetInput): Promise<boolean>;
  prune(input: MemoryStorePruneInput): Promise<MemoryStorePruneResult>;
  countByKind(input: MemoryStoreCountInput): Promise<MemoryKindCounts>;
  close(): Promise<void>;
}

export interface MemoryRecallScores {
  readonly access: number;
  readonly lexical?: number | undefined;
  readonly quality: number;
  readonly recency: number;
  readonly vector?: number | undefined;
}

export interface MemoryRecallResult {
  readonly memory: MemoryRecord;
  readonly reasons: readonly MemoryRecallReason[];
  readonly score: number;
  readonly scores: MemoryRecallScores;
}

export interface MemoryRerankInput {
  readonly candidates: MemoryCandidateSet;
  readonly kindResultLimit: number;
  readonly limit: number;
  readonly maxChars: number;
  readonly now: string;
  readonly policy: MemoryPolicy;
}

export interface MemoryReranker {
  rerank(input: MemoryRerankInput): readonly MemoryRecallResult[];
}

export interface MemoryOperationEvent {
  readonly code?: string | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly durationMs?: number | undefined;
  readonly endedAt?: string | undefined;
  readonly mode?: "hybrid" | "lexical" | undefined;
  readonly namespaceHash: string;
  readonly operation: MemoryOperation;
  readonly operationId: string;
  readonly parentOperationId?: string | undefined;
  readonly phase: MemoryOperationPhase;
  readonly startedAt: string;
}

export type MemoryEventHandler = (event: MemoryOperationEvent) => void;

export interface MemoryManagerOptions {
  readonly clock?: MemoryClock | undefined;
  readonly embeddingProvider?: EmbeddingProvider | undefined;
  readonly extractor?: MemoryExtractor | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly onEvent?: MemoryEventHandler | undefined;
  readonly policy?: MemoryPolicy | undefined;
  readonly redactors?: readonly MemoryRedactor[] | undefined;
  readonly reranker?: MemoryReranker | undefined;
  readonly store: MemoryStore;
}

export interface SqliteMemoryStoreOptions {
  readonly busyTimeoutMs?: number | undefined;
  readonly filePath: string;
}

export interface RenderMemoryContextOptions {
  readonly maxChars: number;
}

export interface RenderedMemoryContext {
  readonly charactersByClass: Readonly<Record<MemorySearchClass, number>>;
  readonly content: string;
}
