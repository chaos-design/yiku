import { randomUUID } from "node:crypto";
import type { AtomicDefinition, AtomicEdgeKind, AtomicSpan } from "@yiku/atomic-flow";
import { MEMORY_ATOMS, MEMORY_CLASS_ATOMS } from "./atoms.js";
import { countMemoryClasses, MEMORY_CLASS_ORDER } from "./classification.js";
import {
  asMemoryError,
  MemoryAbortError,
  MemoryEmbeddingError,
  MemoryError,
  MemoryExtractionError,
  MemoryStoreError,
  MemoryValidationError,
  throwIfAborted,
} from "./errors.js";
import { MemoryEvents, type MemoryOperationSpan } from "./events.js";
import {
  canonicalJson,
  createFingerprint,
  createIdempotencyHash,
  createScopeKey,
  DefaultMemoryPolicy,
  normalizeContent,
  redactMemoryContent,
  validateContent,
  validateContext,
  validateDate,
  validateKind,
  validateMetadata,
  validatePositiveInteger,
  validateScore,
  validateSource,
  validateTags,
} from "./policy/index.js";
import { DefaultMemoryReranker, toMemoryRecord } from "./retrieval/default-reranker.js";
import type {
  EmbeddingProvider,
  ExtractSessionInput,
  ExtractSessionResult,
  ForgetMemoryInput,
  GetMemoryInput,
  IngestSessionInput,
  IngestSessionResult,
  MemoryClassCounts,
  MemoryContext,
  MemoryDraft,
  MemoryEmbedding,
  MemoryManagerOptions,
  MemoryOperation,
  MemoryOperationOptions,
  MemoryPolicy,
  MemoryRecallResult,
  MemoryRecord,
  PruneMemoriesInput,
  PruneMemoriesResult,
  RecallMemoryInput,
  RememberMemoryInput,
  SearchLongTermMemoryInput,
  StoredMemory,
  StoredMemoryWrite,
  UpdateMemoryInput,
} from "./types.js";

interface PreparedWrites {
  readonly redacted: number;
  readonly writes: readonly StoredMemoryWrite[];
}

interface EmbeddedWrites {
  readonly degraded: boolean;
  readonly writes: readonly StoredMemoryWrite[];
}

interface QueryEmbedding {
  readonly degraded: boolean;
  readonly embedding?: MemoryEmbedding | undefined;
}

const systemClock = {
  now: () => new Date(),
};

export class MemoryManager {
  private closed = false;
  private readonly clock;
  private readonly embeddingProvider: EmbeddingProvider | undefined;
  private readonly events: MemoryEvents;
  private readonly extractor;
  private readonly idGenerator;
  private initializationPromise: Promise<void> | undefined;
  private readonly policy: MemoryPolicy;
  private readonly redactors;
  private readonly reranker;
  private readonly store;

  public constructor(options: MemoryManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.embeddingProvider = options.embeddingProvider;
    this.events = new MemoryEvents(options.onEvent);
    this.extractor = options.extractor;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.policy = options.policy ?? new DefaultMemoryPolicy();
    this.redactors = options.redactors ?? [];
    this.reranker = options.reranker ?? new DefaultMemoryReranker();
    this.store = options.store;
  }

  public async remember(input: RememberMemoryInput): Promise<MemoryRecord> {
    const memories = await this.rememberMany([input]);
    const memory = memories[0];

    if (memory === undefined) {
      throw new MemoryStoreError(
        "MEMORY_STORE_UNAVAILABLE",
        "Memory Store did not return the inserted record.",
        { operation: "remember" },
      );
    }

    return memory;
  }

  public async rememberMany(
    inputs: readonly RememberMemoryInput[],
  ): Promise<readonly MemoryRecord[]> {
    return this.rememberManyInternal(inputs);
  }

  public async extractSession(input: ExtractSessionInput): Promise<ExtractSessionResult> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start("extract", context.namespace);
    const atomicSpan = startAtomic(input, MEMORY_ATOMS.extract);

    try {
      throwIfAborted(input.signal, "extract");
      validateRequiredText(input.prompt, "Session prompt");
      validateRequiredText(input.output, "Session output");
      validateIdentifier(input.sessionId, "Session ID");

      if (this.extractor === undefined) {
        throw new MemoryExtractionError(
          "MEMORY_EXTRACTION_NOT_CONFIGURED",
          "Session extraction requires a MemoryExtractor.",
          { operation: "extract" },
        );
      }

      const drafts = await this.extractor.extract(
        {
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          context,
          output: input.output,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          prompt: input.prompt,
          sessionId: input.sessionId,
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          ...(input.workingMemories !== undefined
            ? { workingMemories: input.workingMemories }
            : {}),
        },
        { signal: input.signal },
      );
      throwIfAborted(input.signal, "extract");

      if (!Array.isArray(drafts)) {
        throw new MemoryExtractionError(
          "MEMORY_EXTRACTION_FAILED",
          "MemoryExtractor must return an array of drafts.",
          { operation: "extract" },
        );
      }

      const accepted = drafts.filter(
        (draft) => validateScore(draft.confidence, 0) >= this.policy.extractedConfidenceThreshold,
      );
      const result = {
        discarded: drafts.length - accepted.length,
        drafts: accepted,
        extracted: drafts.length,
      };
      const counts = {
        accepted: accepted.length,
        discarded: result.discarded,
        extracted: result.extracted,
      };
      span.end({ counts });
      atomicSpan?.end({ counts });
      return result;
    } catch (error) {
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(span, error, "extract", "Memory session extraction failed.");
    }
  }

  public async ingestSession(input: IngestSessionInput): Promise<IngestSessionResult> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start("ingest", context.namespace);
    const atomicSpan = startAtomic(input, MEMORY_ATOMS.extract);

    try {
      throwIfAborted(input.signal, "ingest");
      validateRequiredText(input.prompt, "Session prompt");
      validateRequiredText(input.output, "Session output");
      const sessionId = validateIdentifier(input.sessionId, "Session ID");

      if (this.extractor === undefined) {
        throw new MemoryExtractionError(
          "MEMORY_EXTRACTION_NOT_CONFIGURED",
          "Session ingestion requires a MemoryExtractor.",
          { operation: "ingest" },
        );
      }

      await this.ensureInitialized(context, input.signal, span.id);
      let drafts: readonly MemoryDraft[];

      try {
        drafts = await this.extractor.extract(
          {
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            context,
            output: input.output,
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            prompt: input.prompt,
            sessionId,
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
            ...(input.workingMemories !== undefined
              ? { workingMemories: input.workingMemories }
              : {}),
          },
          { signal: input.signal },
        );
        throwIfAborted(input.signal, "ingest");
      } catch (error) {
        if (error instanceof MemoryAbortError) {
          throw error;
        }

        throw new MemoryExtractionError("MEMORY_EXTRACTION_FAILED", "Memory extraction failed.", {
          cause: error,
          operation: "ingest",
        });
      }

      if (!Array.isArray(drafts)) {
        throw new MemoryExtractionError(
          "MEMORY_EXTRACTION_FAILED",
          "MemoryExtractor must return an array of drafts.",
          { operation: "ingest" },
        );
      }

      const accepted = drafts.filter(
        (draft) => validateScore(draft.confidence, 0) >= this.policy.extractedConfidenceThreshold,
      );
      const rememberInputs = accepted.map((draft) =>
        draftToRememberInput(
          draft,
          context,
          sessionId,
          input.signal,
          input.atomicFlow,
          atomicSpan?.instanceId,
        ),
      );
      const memories =
        rememberInputs.length === 0 ? [] : await this.rememberManyInternal(rememberInputs, span.id);
      const result = {
        discarded: drafts.length - accepted.length,
        extracted: drafts.length,
        memories,
      };

      span.end({
        counts: {
          discarded: result.discarded,
          extracted: result.extracted,
          written: result.memories.length,
        },
      });
      atomicSpan?.end({
        counts: {
          discarded: result.discarded,
          extracted: result.extracted,
          written: result.memories.length,
        },
      });
      return result;
    } catch (error) {
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(span, error, "ingest", "Memory session ingestion failed.");
    }
  }

  public async recall(input: RecallMemoryInput): Promise<readonly MemoryRecallResult[]> {
    return this.retrieve(input, "recall");
  }

  public async search(input: SearchLongTermMemoryInput): Promise<readonly MemoryRecallResult[]> {
    return this.retrieve(input, "search");
  }

  private async retrieve(
    input: RecallMemoryInput,
    operation: "recall" | "search",
  ): Promise<readonly MemoryRecallResult[]> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start(operation, context.namespace);
    const atomicSpan = startAtomic(
      input,
      operation === "recall" ? MEMORY_ATOMS.recall : MEMORY_ATOMS.search,
    );
    const searchSpan =
      operation === "recall"
        ? startAtomic(input, MEMORY_ATOMS.search, atomicSpan?.instanceId)
        : atomicSpan;

    try {
      throwIfAborted(input.signal, operation);
      const query = validateContent(input.query, this.policy);
      const limit = validatePositiveInteger(
        input.limit ?? this.policy.defaultRecallLimit,
        this.policy.maxRecallLimit,
        "Memory search limit",
      );
      const maxChars = validatePositiveInteger(
        input.maxChars ?? this.policy.defaultRecallMaxChars,
        this.policy.maxRecallMaxChars,
        "Memory search character budget",
      );
      const kinds =
        input.kinds === undefined
          ? undefined
          : [...new Set(input.kinds.map((kind) => validateKind(kind)))];
      const tags = input.tags === undefined ? undefined : validateTags(input.tags, this.policy);
      await this.ensureInitialized(context, input.signal, span.id);
      const embeddingSpan = startAtomic(input, MEMORY_ATOMS.queryEmbedding, searchSpan?.instanceId);
      const queryEmbedding = await this.embedQuery(query, input.signal);
      embeddingSpan?.end({
        summary: queryEmbedding.degraded ? "lexical fallback" : "embedding ready",
      });
      const candidates = await this.store.search({
        context,
        ...(queryEmbedding.embedding !== undefined
          ? {
              embeddingModel: queryEmbedding.embedding.model,
              queryEmbedding: queryEmbedding.embedding.values,
            }
          : {}),
        ...(kinds !== undefined ? { kinds } : {}),
        lexicalLimit: this.policy.lexicalCandidateLimit,
        now: this.now(),
        query,
        signal: input.signal,
        ...(tags !== undefined ? { tags } : {}),
        vectorLimit: this.policy.vectorCandidateLimit,
        vectorScanLimit: this.policy.maxVectorScan,
      });
      emitCompletedAtomic(
        input,
        MEMORY_ATOMS.ftsSearch,
        embeddingSpan?.instanceId ?? searchSpan?.instanceId,
        candidates.lexical.length,
      );
      emitCompletedAtomic(
        input,
        MEMORY_ATOMS.vectorSearch,
        embeddingSpan?.instanceId ?? searchSpan?.instanceId,
        candidates.vector.length,
      );
      throwIfAborted(input.signal, operation);
      const rerankSpan = startAtomic(input, MEMORY_ATOMS.rerank, searchSpan?.instanceId);
      const results = this.reranker.rerank({
        candidates,
        kindResultLimit: this.policy.kindResultLimit,
        limit,
        maxChars,
        now: this.now(),
        policy: this.policy,
      });
      rerankSpan?.end({
        counts: {
          selected: results.length,
        },
      });
      emitMemoryClassAtoms(
        input,
        results.map((result) => result.memory.kind),
        rerankSpan?.instanceId ?? searchSpan?.instanceId,
      );

      if (operation === "recall" && results.length > 0) {
        await this.store.touch({
          context,
          ids: results.map((result) => result.memory.id),
          signal: input.signal,
          touchedAt: this.now(),
        });
      }

      const degraded = queryEmbedding.degraded || candidates.vectorScanExceeded;
      span.end({
        ...(degraded
          ? {
              code: candidates.vectorScanExceeded
                ? "MEMORY_VECTOR_SCAN_LIMIT"
                : "MEMORY_EMBEDDING_FAILED",
            }
          : {}),
        counts: {
          lexicalCandidates: candidates.lexical.length,
          results: results.length,
          vectorCandidates: candidates.vector.length,
        },
        mode:
          queryEmbedding.embedding !== undefined && !candidates.vectorScanExceeded
            ? "hybrid"
            : "lexical",
      });
      const atomicPayload = {
        counts: {
          lexicalCandidates: candidates.lexical.length,
          selected: results.length,
          vectorCandidates: candidates.vector.length,
        },
        summary: degraded ? "degraded" : "completed",
      };
      searchSpan?.end(atomicPayload);
      if (searchSpan !== atomicSpan) {
        atomicSpan?.end(atomicPayload);
      }
      return results;
    } catch (error) {
      if (searchSpan !== atomicSpan) {
        searchSpan?.fail({
          code: getErrorCode(error),
          summary: getErrorMessage(error),
        });
      }
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(
        span,
        error,
        operation,
        operation === "recall" ? "Memory recall failed." : "Memory search failed.",
      );
    }
  }

  public async countByClass(
    input: Pick<GetMemoryInput, "context" | "signal">,
  ): Promise<MemoryClassCounts> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    throwIfAborted(input.signal);
    await this.ensureInitialized(context, input.signal);
    const counts = await this.store.countByKind({
      context,
      now: this.now(),
      signal: input.signal,
    });
    return {
      procedure: counts.procedure,
      scenario: counts.decision + counts.episode,
      semantic: counts.fact + counts.preference,
    };
  }

  public async get(input: GetMemoryInput): Promise<MemoryRecord | undefined> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const id = validateIdentifier(input.id, "Memory ID");
    throwIfAborted(input.signal);
    await this.ensureInitialized(context, input.signal);

    try {
      const memory = await this.store.get({
        context,
        id,
        signal: input.signal,
      });
      return memory === undefined ? undefined : toMemoryRecord(memory);
    } catch (error) {
      throw asMemoryError(error, "recall", "Memory get operation failed.");
    }
  }

  public async update(input: UpdateMemoryInput): Promise<MemoryRecord> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start("update", context.namespace);

    try {
      const id = validateIdentifier(input.id, "Memory ID");
      validatePositiveInteger(input.expectedRevision, Number.MAX_SAFE_INTEGER, "Expected revision");
      throwIfAborted(input.signal, "update");
      await this.ensureInitialized(context, input.signal, span.id);
      const current = await this.store.get({
        context,
        id,
        signal: input.signal,
      });

      if (current === undefined) {
        throw new MemoryStoreError("MEMORY_NOT_FOUND", "Memory record was not found.", {
          operation: "update",
        });
      }

      const updatedAt = this.now();
      const contentResult =
        input.patch.content === undefined
          ? {
              content: current.content,
              redacted: false,
            }
          : this.prepareContent(input.patch.content);
      const kind = input.patch.kind === undefined ? current.kind : validateKind(input.patch.kind);
      const normalizedContent = normalizeContent(contentResult.content);
      const expiresAt = resolveUpdatedExpiry(input.patch.expiresAt, current.expiresAt);
      const withoutDerived = removeDerivedFields(current);
      let update: StoredMemoryWrite = {
        ...withoutDerived,
        confidence: validateScore(input.patch.confidence, current.confidence),
        content: contentResult.content,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        fingerprint: createFingerprint(kind, normalizedContent),
        importance: validateScore(input.patch.importance, current.importance),
        kind,
        metadata:
          input.patch.metadata === undefined
            ? current.metadata
            : validateMetadata(input.patch.metadata, this.policy),
        normalizedContent,
        source:
          input.patch.source === undefined ? current.source : validateSource(input.patch.source),
        tags:
          input.patch.tags === undefined
            ? current.tags
            : validateTags(input.patch.tags, this.policy),
        updatedAt,
      };
      let degraded = false;

      if (input.patch.content === undefined) {
        if (current.embedding !== undefined) {
          update = {
            ...update,
            embedding: current.embedding,
          };
        }
      } else {
        const embedded = await this.embedWrites([update], input.signal);
        update = embedded.writes[0] ?? update;
        degraded = embedded.degraded;
      }

      const stored = await this.store.update({
        context,
        expectedRevision: input.expectedRevision,
        memory: update,
        signal: input.signal,
      });
      span.end({
        ...(degraded
          ? { code: "MEMORY_EMBEDDING_FAILED" }
          : contentResult.redacted
            ? { code: "MEMORY_CONTENT_REDACTED" }
            : {}),
        counts: {
          updated: 1,
        },
        mode: stored.embedding === undefined ? "lexical" : "hybrid",
      });
      return toMemoryRecord(stored);
    } catch (error) {
      throw this.fail(span, error, "update", "Memory update failed.");
    }
  }

  public async forget(input: ForgetMemoryInput): Promise<boolean> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start("forget", context.namespace);
    const atomicSpan = startAtomic(input, MEMORY_ATOMS.forget);

    try {
      const id = validateIdentifier(input.id, "Memory ID");
      throwIfAborted(input.signal, "forget");
      await this.ensureInitialized(context, input.signal, span.id);
      const forgotten = await this.store.forget({
        context,
        id,
        mode: input.mode ?? "soft",
        signal: input.signal,
        updatedAt: this.now(),
      });
      span.end({
        counts: {
          deleted: forgotten ? 1 : 0,
        },
      });
      atomicSpan?.end({
        counts: {
          forgotten: forgotten ? 1 : 0,
        },
      });
      return forgotten;
    } catch (error) {
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(span, error, "forget", "Memory forget operation failed.");
    }
  }

  public async prune(input: PruneMemoriesInput): Promise<PruneMemoriesResult> {
    this.ensureOpen();
    const context = validateContext(input.context, this.policy);
    const span = this.events.start("prune", context.namespace);
    const atomicSpan = startAtomic(input, MEMORY_ATOMS.prune);

    try {
      const before = validateDate(input.before, "Memory prune cutoff");
      throwIfAborted(input.signal, "prune");
      await this.ensureInitialized(context, input.signal, span.id);
      const result = await this.store.prune({
        before,
        context,
        now: this.now(),
        signal: input.signal,
      });
      span.end({
        counts: {
          deleted: result.deleted,
        },
      });
      atomicSpan?.end({
        counts: {
          deleted: result.deleted,
        },
      });
      return result;
    } catch (error) {
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(span, error, "prune", "Memory prune operation failed.");
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      await this.initializationPromise;
    } catch {
      // A failed initialization does not prevent Store cleanup.
    }

    await this.store.close();
  }

  private async rememberManyInternal(
    inputs: readonly RememberMemoryInput[],
    parentOperationId?: string,
  ): Promise<readonly MemoryRecord[]> {
    this.ensureOpen();

    if (inputs.length === 0) {
      return [];
    }

    if (inputs.length > this.policy.maxBatchSize) {
      throw new MemoryValidationError(
        "MEMORY_INVALID_CONTENT",
        `Memory batch exceeds ${this.policy.maxBatchSize} records.`,
        { operation: "remember" },
      );
    }

    const normalizedContexts = inputs.map((input) => validateContext(input.context, this.policy));
    const context = normalizedContexts[0] as MemoryContext;

    const contextKey = canonicalJson(context);

    if (normalizedContexts.some((candidate) => canonicalJson(candidate) !== contextKey)) {
      throw new MemoryValidationError(
        "MEMORY_INVALID_CONTEXT",
        "All memories in a batch must use the same context.",
        { operation: "remember" },
      );
    }

    const span = this.events.start("remember", context.namespace, parentOperationId);
    const operation = inputs[0];
    const atomicSpan =
      operation === undefined ? undefined : startAtomic(operation, MEMORY_ATOMS.write);

    try {
      throwIfAborted(inputs[0]?.signal, "remember");
      await this.ensureInitialized(context, inputs[0]?.signal, span.id);
      const prepared = this.prepareWrites(inputs, normalizedContexts);
      const embedded = await this.embedWrites(prepared.writes, inputs[0]?.signal);
      const stored = await this.store.rememberMany(embedded.writes, {
        signal: inputs[0]?.signal,
      });
      span.end({
        ...(embedded.degraded
          ? { code: "MEMORY_EMBEDDING_FAILED" }
          : prepared.redacted > 0
            ? { code: "MEMORY_CONTENT_REDACTED" }
            : {}),
        counts: {
          redacted: prepared.redacted,
          written: stored.length,
        },
        mode: this.embeddingProvider !== undefined && !embedded.degraded ? "hybrid" : "lexical",
      });
      atomicSpan?.end({
        counts: {
          redacted: prepared.redacted,
          written: stored.length,
        },
        summary: embedded.degraded ? "lexical persistence" : "hybrid persistence",
      });
      return stored.map(toMemoryRecord);
    } catch (error) {
      atomicSpan?.fail({
        code: getErrorCode(error),
        summary: getErrorMessage(error),
      });
      throw this.fail(span, error, "remember", "Memory write failed.");
    }
  }

  private prepareWrites(
    inputs: readonly RememberMemoryInput[],
    contexts: readonly MemoryContext[],
  ): PreparedWrites {
    const now = this.now();
    let redacted = 0;
    const writes = inputs.map((input, index) => {
      const context = contexts[index] as MemoryContext;

      const contentResult = this.prepareContent(input.content);
      redacted += contentResult.redacted ? 1 : 0;
      const kind = validateKind(input.kind);
      const normalizedContent = normalizeContent(contentResult.content);
      const metadata = validateMetadata(input.metadata, this.policy);
      const tags = validateTags(input.tags, this.policy);
      const source = validateSource(input.source);
      const expiresAt = resolveExpiry(input.expiresAt, this.policy.defaultRetentionMs[kind], now);
      const idempotencyKey =
        input.idempotencyKey === undefined
          ? undefined
          : validateIdentifier(input.idempotencyKey, "Memory idempotency key");
      const idempotencyHash =
        idempotencyKey === undefined
          ? undefined
          : createIdempotencyHash({
              confidence: input.confidence ?? 0.5,
              content: contentResult.content,
              context,
              expiresAt: input.expiresAt ?? null,
              importance: input.importance ?? 0.5,
              kind,
              metadata,
              source,
              tags,
            });

      return {
        accessCount: 0,
        confidence: validateScore(input.confidence, 0.5),
        content: contentResult.content,
        createdAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        fingerprint: createFingerprint(kind, normalizedContent),
        id: this.idGenerator(),
        ...(idempotencyHash !== undefined ? { idempotencyHash } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        importance: validateScore(input.importance, 0.5),
        kind,
        metadata,
        namespace: context.namespace,
        normalizedContent,
        revision: 1,
        scope: context.scope ?? {},
        scopeKey: createScopeKey(context.scope ?? {}),
        source,
        status: "active" as const,
        tags,
        updatedAt: now,
      };
    });

    return {
      redacted,
      writes,
    };
  }

  private prepareContent(content: string): {
    readonly content: string;
    readonly redacted: boolean;
  } {
    const validated = validateContent(content, this.policy);
    const redaction = redactMemoryContent(validated, this.redactors);

    return {
      content: validateContent(redaction.content, this.policy),
      redacted: redaction.redactors.length > 0,
    };
  }

  private async embedWrites(
    writes: readonly StoredMemoryWrite[],
    signal?: AbortSignal,
  ): Promise<EmbeddedWrites> {
    const provider = this.embeddingProvider;

    if (provider === undefined || writes.length === 0) {
      return {
        degraded: false,
        writes,
      };
    }

    try {
      const embeddings: MemoryEmbedding[] = [];

      for (let offset = 0; offset < writes.length; offset += this.policy.embeddingBatchSize) {
        throwIfAborted(signal, "remember");
        const batch = writes.slice(offset, offset + this.policy.embeddingBatchSize);
        const vectors = await provider.embed(
          batch.map((write) => write.normalizedContent),
          { signal },
        );
        throwIfAborted(signal, "remember");

        if (vectors.length !== batch.length) {
          throw new MemoryEmbeddingError(
            "MEMORY_EMBEDDING_INVALID",
            "Embedding provider returned an unexpected number of vectors.",
            { operation: "remember" },
          );
        }

        embeddings.push(
          ...vectors.map((vector) => validateEmbedding(vector, provider, "remember")),
        );
      }

      return {
        degraded: false,
        writes: writes.map((write, index) => ({
          ...write,
          embedding: embeddings[index] as MemoryEmbedding,
        })),
      };
    } catch (error) {
      throwIfAborted(signal, "remember");

      if (this.policy.embeddingFailureMode === "lexical") {
        return {
          degraded: true,
          writes,
        };
      }

      if (error instanceof MemoryEmbeddingError) {
        throw error;
      }

      throw new MemoryEmbeddingError("MEMORY_EMBEDDING_FAILED", "Memory embedding failed.", {
        cause: error,
        operation: "remember",
      });
    }
  }

  private async embedQuery(query: string, signal?: AbortSignal): Promise<QueryEmbedding> {
    const provider = this.embeddingProvider;

    if (provider === undefined) {
      return { degraded: false };
    }

    try {
      throwIfAborted(signal, "recall");
      const vectors = await provider.embed([normalizeContent(query)], { signal });
      throwIfAborted(signal, "recall");

      if (vectors.length !== 1 || vectors[0] === undefined) {
        throw new MemoryEmbeddingError(
          "MEMORY_EMBEDDING_INVALID",
          "Embedding provider must return exactly one query vector.",
          { operation: "recall" },
        );
      }

      return {
        degraded: false,
        embedding: validateEmbedding(vectors[0], provider, "recall"),
      };
    } catch (error) {
      throwIfAborted(signal, "recall");

      if (this.policy.embeddingFailureMode === "lexical") {
        return { degraded: true };
      }

      if (error instanceof MemoryEmbeddingError) {
        throw error;
      }

      throw new MemoryEmbeddingError("MEMORY_EMBEDDING_FAILED", "Memory query embedding failed.", {
        cause: error,
        operation: "recall",
      });
    }
  }

  private async ensureInitialized(
    context: MemoryContext,
    signal?: AbortSignal,
    parentOperationId?: string,
  ): Promise<void> {
    this.ensureOpen();
    throwIfAborted(signal, "initialize");

    if (this.initializationPromise === undefined) {
      const span = this.events.start("initialize", context.namespace, parentOperationId);
      this.initializationPromise = this.store
        .initialize({ signal })
        .then(() => {
          span.end();
        })
        .catch((error: unknown) => {
          const memoryError = asMemoryError(
            error,
            "initialize",
            "Memory Store initialization failed.",
          );
          span.error(memoryError.code);
          throw memoryError;
        });
    }

    const initialization = this.initializationPromise;

    try {
      await initialization;
    } catch (error) {
      this.initializationPromise = undefined;
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new MemoryStoreError("MEMORY_MANAGER_CLOSED", "MemoryManager is closed.");
    }
  }

  private fail(
    span: MemoryOperationSpan,
    error: unknown,
    operation: MemoryOperation,
    fallbackMessage: string,
  ): MemoryError {
    const memoryError = asMemoryError(error, operation, fallbackMessage);
    span.error(memoryError.code);
    return memoryError;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function validateEmbedding(
  vector: readonly number[],
  provider: EmbeddingProvider,
  operation: "recall" | "remember",
): MemoryEmbedding {
  if (!Array.isArray(vector) || vector.length !== provider.dimensions || vector.length === 0) {
    throw new MemoryEmbeddingError(
      "MEMORY_EMBEDDING_INVALID",
      `Embedding provider ${provider.model} returned an invalid dimension.`,
      { operation },
    );
  }

  let magnitude = 0;

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new MemoryEmbeddingError(
        "MEMORY_EMBEDDING_INVALID",
        `Embedding provider ${provider.model} returned a non-finite value.`,
        { operation },
      );
    }

    magnitude += value * value;
  }

  if (magnitude === 0) {
    throw new MemoryEmbeddingError(
      "MEMORY_EMBEDDING_INVALID",
      `Embedding provider ${provider.model} returned a zero vector.`,
      { operation },
    );
  }

  return {
    dimensions: provider.dimensions,
    model: provider.model,
    values: [...vector],
  };
}

function draftToRememberInput(
  draft: MemoryDraft,
  context: MemoryContext,
  sessionId: string,
  signal?: AbortSignal,
  atomicFlow?: MemoryOperationOptions["atomicFlow"],
  atomicParentInstanceId?: string,
): RememberMemoryInput {
  return {
    ...(atomicFlow !== undefined ? { atomicFlow } : {}),
    ...(atomicParentInstanceId !== undefined ? { atomicParentInstanceId } : {}),
    confidence: draft.confidence,
    content: draft.content,
    context,
    ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
    importance: draft.importance,
    kind: draft.kind,
    ...(draft.metadata !== undefined ? { metadata: draft.metadata } : {}),
    signal,
    source: {
      id: sessionId,
      type: "session",
    },
    ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
  };
}

function startAtomic(
  input: MemoryOperationOptions,
  atom: AtomicDefinition,
  parentInstanceId = input.atomicParentInstanceId,
): AtomicSpan | undefined {
  const source = memorySource(atom.key);
  return input.atomicFlow?.start({
    atom,
    ...(parentInstanceId !== undefined && source !== undefined
      ? {
          edge: {
            fromAtomKey: source.key,
            kind: source.kind,
            toAtomKey: atom.key,
          },
        }
      : {}),
    ...(parentInstanceId !== undefined ? { parentInstanceId } : {}),
  });
}

function emitCompletedAtomic(
  input: MemoryOperationOptions,
  atom: AtomicDefinition,
  parentInstanceId: string | undefined,
  count: number,
): void {
  startAtomic(input, atom, parentInstanceId)?.end({
    counts: {
      candidates: count,
    },
  });
}

function emitMemoryClassAtoms(
  input: MemoryOperationOptions,
  kinds: readonly import("./types.js").MemoryKind[],
  parentInstanceId: string | undefined,
): void {
  const counts = countMemoryClasses(kinds);
  for (const memoryClass of MEMORY_CLASS_ORDER) {
    const count = counts[memoryClass];
    if (count > 0) {
      emitCompletedAtomic(input, MEMORY_CLASS_ATOMS[memoryClass], parentInstanceId, count);
    }
  }
}

function memorySource(
  atomKey: string,
): { readonly key: string; readonly kind: AtomicEdgeKind } | undefined {
  switch (atomKey) {
    case "memory.recall":
      return { key: "input.prompt", kind: "data" };
    case "memory.search":
      return { key: "memory.recall", kind: "execution" };
    case "memory.query-embedding":
      return { key: "memory.search", kind: "execution" };
    case "memory.fts-search":
    case "memory.vector-search":
      return { key: "memory.query-embedding", kind: "execution" };
    case "memory.rerank":
      return { key: "memory.vector-search", kind: "data" };
    case "memory.procedure":
    case "memory.scenario":
    case "memory.semantic":
      return { key: "memory.rerank", kind: "data" };
    case "memory.extract":
      return { key: "reply.final", kind: "feedback" };
    case "memory.write":
      return { key: "memory.extract", kind: "execution" };
    default:
      return undefined;
  }
}

function getErrorCode(error: unknown): string {
  return error instanceof MemoryError ? error.code : "MEMORY_OPERATION_FAILED";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExpiry(
  configured: string | undefined,
  retentionMs: number | undefined,
  now: string,
): string | undefined {
  if (configured !== undefined) {
    return validateDate(configured, "Memory expiry");
  }

  if (retentionMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new MemoryValidationError(
      "MEMORY_INVALID_DATE",
      "Memory retention must be a positive finite duration.",
    );
  }

  return new Date(Date.parse(now) + retentionMs).toISOString();
}

function resolveUpdatedExpiry(
  configured: string | null | undefined,
  current: string | undefined,
): string | undefined {
  if (configured === null) {
    return undefined;
  }

  return configured === undefined ? current : validateDate(configured, "Memory expiry");
}

function removeDerivedFields(memory: StoredMemory): Omit<StoredMemory, "embedding" | "expiresAt"> {
  const { embedding: _embedding, expiresAt: _expiresAt, ...record } = memory;
  return record;
}

function validateRequiredText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryValidationError("MEMORY_INVALID_CONTENT", `${name} must be non-empty.`);
  }

  return value;
}

function validateIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryValidationError("MEMORY_INVALID_CONTENT", `${name} must be non-empty.`);
  }

  const normalized = value.trim();

  if (Buffer.byteLength(normalized, "utf8") > 256) {
    throw new MemoryValidationError("MEMORY_INVALID_CONTENT", `${name} exceeds 256 UTF-8 bytes.`);
  }

  return normalized;
}
