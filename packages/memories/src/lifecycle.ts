import { randomUUID } from "node:crypto";
import type { AtomicDefinition, AtomicFlowRun, AtomicSpan } from "@yiku/atomic-flow";
import { MEMORY_ATOMS, MEMORY_CLASS_ATOMS } from "./atoms.js";
import { countMemoryClasses, memoryClassForKind } from "./classification.js";
import type { MemoryManager } from "./manager.js";
import {
  createFingerprint,
  DefaultMemoryPolicy,
  normalizeContent,
  redactMemoryContent,
  validateContent,
  validateKind,
  validateMetadata,
  validateScore,
  validateTags,
} from "./policy/index.js";
import type {
  CaptureWorkingMemoryInput,
  ConsolidateMemoriesInput,
  ConsolidateMemoriesResult,
  ExtractSessionInput,
  ExtractSessionResult,
  ForgetUnifiedMemoryInput,
  ForgetUnifiedMemoryResult,
  MemoryClass,
  MemoryContext,
  MemoryDraft,
  MemoryLifecycleStatus,
  MemoryPolicy,
  MemoryRedactor,
  MemorySearchClass,
  MemorySearchResult,
  PruneMemoriesInput,
  PruneMemoriesResult,
  SearchMemoriesInput,
  WorkingMemoryRecord,
  WorkingMemorySource,
  WorkingMemoryStore,
} from "./types.js";
import { InMemoryWorkingMemoryStore } from "./working-memory.js";

const LONG_TERM_CLASSES = new Set<MemorySearchClass>(["procedure", "scenario", "semantic"]);
const MAX_WORKING_MEMORIES = 500;

export interface MemoryLifecycleOptions {
  readonly clock?: { now(): Date } | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly manager: MemoryManager;
  readonly policy?: MemoryPolicy | undefined;
  readonly redactors?: readonly MemoryRedactor[] | undefined;
  readonly workingStore?: WorkingMemoryStore | undefined;
}

export class MemoryLifecycle {
  private readonly clock: { now(): Date };
  private readonly idGenerator: () => string;
  private readonly manager: MemoryManager;
  private readonly policy: MemoryPolicy;
  private readonly redactors: readonly MemoryRedactor[];
  private readonly workingStore: WorkingMemoryStore;

  public constructor(options: MemoryLifecycleOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.manager = options.manager;
    this.policy = options.policy ?? new DefaultMemoryPolicy();
    this.redactors = options.redactors ?? [];
    this.workingStore = options.workingStore ?? new InMemoryWorkingMemoryStore();
  }

  public async captureWorking(input: CaptureWorkingMemoryInput): Promise<WorkingMemoryRecord> {
    const sessionId = requireIdentifier(input.sessionId, "Working Memory Session ID");
    const captureSpan = startSpan(
      input.atomicFlow,
      MEMORY_ATOMS.workingCapture,
      input.atomicParentInstanceId,
      "feedback",
    );

    try {
      const content = this.prepareContent(input.content);
      const draft = input.draft === undefined ? undefined : this.prepareDraft(input.draft);
      const records = await this.workingStore.list(sessionId);
      const existing = records.find(
        (record) =>
          record.status === "active" &&
          record.source === input.source &&
          normalizeContent(record.content) === normalizeContent(content),
      );
      const now = this.now();
      const record: WorkingMemoryRecord =
        existing === undefined
          ? {
              content,
              createdAt: now,
              ...(draft !== undefined ? { draft } : {}),
              id: this.idGenerator(),
              sessionId,
              source: input.source,
              status: "active",
              updatedAt: now,
            }
          : {
              ...existing,
              ...(draft !== undefined ? { draft } : {}),
              updatedAt: now,
            };
      const nextRecords =
        existing === undefined
          ? [...records, record]
          : records.map((candidate) => (candidate.id === existing.id ? record : candidate));
      await this.workingStore.replace(sessionId, nextRecords.slice(-MAX_WORKING_MEMORIES));
      captureSpan?.end({
        counts: {
          captured: 1,
          deduplicated: existing === undefined ? 0 : 1,
        },
      });
      emitCompleted(
        input.atomicFlow,
        MEMORY_ATOMS.working,
        captureSpan?.instanceId ?? input.atomicParentInstanceId,
        { active: 1 },
        "data",
      );
      return record;
    } catch (error) {
      captureSpan?.fail({ code: "MEMORY_CAPTURE_FAILED", summary: errorMessage(error) });
      throw error;
    }
  }

  public async extractToWorking(
    input: ExtractSessionInput,
  ): Promise<ExtractSessionResult & { readonly workingMemories: readonly WorkingMemoryRecord[] }> {
    const sessionId = requireIdentifier(input.sessionId, "Working Memory Session ID");
    const workingMemories = await this.workingStore.list(sessionId);
    const extracted = await this.manager.extractSession({
      ...input,
      workingMemories,
    });
    const records: WorkingMemoryRecord[] = [];

    for (const draft of extracted.drafts) {
      records.push(
        await this.captureWorking({
          ...(input.atomicFlow !== undefined ? { atomicFlow: input.atomicFlow } : {}),
          ...(input.atomicFlow !== undefined
            ? {
                atomicParentInstanceId: latestInstanceId(
                  input.atomicFlow,
                  MEMORY_ATOMS.extract.key,
                ),
              }
            : {}),
          content: draft.content,
          draft,
          sessionId,
          signal: input.signal,
          source: "turn-extract",
        }),
      );
    }

    return {
      ...extracted,
      workingMemories: records,
    };
  }

  public async recall(input: SearchMemoriesInput): Promise<readonly MemorySearchResult[]> {
    const span = startSpan(
      input.atomicFlow,
      MEMORY_ATOMS.recall,
      input.atomicParentInstanceId,
      "data",
    );
    try {
      const results = await this.search({
        ...input,
        ...(span !== undefined ? { atomicParentInstanceId: span.instanceId } : {}),
      });
      span?.end({
        counts: {
          selected: results.length,
          working: results.filter((result) => result.tier === "working").length,
        },
      });
      return results;
    } catch (error) {
      span?.fail({ code: "MEMORY_RECALL_FAILED", summary: errorMessage(error) });
      throw error;
    }
  }

  public async search(input: SearchMemoriesInput): Promise<readonly MemorySearchResult[]> {
    const sessionId = requireIdentifier(input.sessionId, "Working Memory Session ID");
    const query = validateContent(input.query, this.policy);
    const limit = input.limit ?? this.policy.defaultRecallLimit;
    const maxChars = input.maxChars ?? this.policy.defaultRecallMaxChars;
    const classes = normalizeClasses(input.classes);
    const includeWorking = classes.includes("working");
    const longTermClasses = classes.filter((item): item is MemoryClass =>
      LONG_TERM_CLASSES.has(item),
    );
    let searchSpan: AtomicSpan | undefined;
    let longTerm = [] as Awaited<ReturnType<MemoryManager["search"]>>;

    if (longTermClasses.length > 0) {
      longTerm = await this.manager.search({
        ...(input.atomicFlow !== undefined ? { atomicFlow: input.atomicFlow } : {}),
        ...(input.atomicParentInstanceId !== undefined
          ? { atomicParentInstanceId: input.atomicParentInstanceId }
          : {}),
        context: input.context,
        kinds: kindsForClasses(longTermClasses),
        limit,
        maxChars,
        query,
        signal: input.signal,
      });
    } else {
      searchSpan = startSpan(
        input.atomicFlow,
        MEMORY_ATOMS.search,
        input.atomicParentInstanceId,
        "data",
      );
    }

    const parentInstanceId =
      searchSpan?.instanceId ??
      (input.atomicFlow === undefined
        ? undefined
        : latestInstanceId(input.atomicFlow, MEMORY_ATOMS.search.key));
    const working = includeWorking
      ? searchWorking(await this.workingStore.list(sessionId), query, limit)
      : [];

    if (working.length > 0) {
      emitCompleted(
        input.atomicFlow,
        MEMORY_ATOMS.working,
        parentInstanceId,
        { selected: working.length },
        "data",
      );
    }
    searchSpan?.end({
      counts: {
        selected: working.length,
        working: working.length,
      },
    });

    return mergeResults(
      working,
      longTerm.map((result) => ({
        class: memoryClassForKind(result.memory.kind),
        content: result.memory.content,
        memory: result.memory,
        reasons: result.reasons,
        score: result.score,
        scores: result.scores,
        tier: "long-term" as const,
      })),
      limit,
      maxChars,
    );
  }

  public async consolidate(input: ConsolidateMemoriesInput): Promise<ConsolidateMemoriesResult> {
    const sessionId = requireIdentifier(input.sessionId, "Working Memory Session ID");
    const records = await this.workingStore.list(sessionId);
    const candidates = records.filter(
      (record): record is WorkingMemoryRecord & { readonly draft: MemoryDraft } =>
        record.status === "active" && record.draft !== undefined,
    );
    const span = startSpan(
      input.atomicFlow,
      MEMORY_ATOMS.consolidate,
      input.atomicParentInstanceId,
      "execution",
    );
    const updated = new Map<string, WorkingMemoryRecord>();
    const memories = [];
    let discarded = 0;
    let failed = 0;

    for (const record of candidates) {
      const draft = record.draft;
      if (draft.confidence < this.policy.extractedConfidenceThreshold) {
        discarded += 1;
        updated.set(record.id, {
          ...record,
          status: "discarded",
          updatedAt: this.now(),
        });
        continue;
      }

      try {
        const memory = await this.manager.remember({
          confidence: draft.confidence,
          content: draft.content,
          context: input.context,
          ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
          idempotencyKey: `working:${sessionId}:${record.id}`,
          importance: draft.importance,
          kind: draft.kind,
          ...(draft.metadata !== undefined ? { metadata: draft.metadata } : {}),
          signal: input.signal,
          source: { id: sessionId, type: "session" },
          ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
        });
        memories.push(memory);
        const now = this.now();
        updated.set(record.id, {
          ...record,
          consolidatedAt: now,
          longTermMemoryId: memory.id,
          status: "consolidated",
          updatedAt: now,
        });
      } catch {
        failed += 1;
      }
    }

    if (updated.size > 0) {
      await this.workingStore.replace(
        sessionId,
        records.map((record) => updated.get(record.id) ?? record),
      );
    }

    const classCounts = countMemoryClasses(memories.map((memory) => memory.kind));
    for (const memoryClass of ["scenario", "procedure", "semantic"] as const) {
      const count = classCounts[memoryClass];
      if (count > 0) {
        emitCompleted(
          input.atomicFlow,
          MEMORY_CLASS_ATOMS[memoryClass],
          span?.instanceId,
          { consolidated: count },
          "data",
        );
      }
    }
    if (memories.length > 0) {
      emitCompleted(
        input.atomicFlow,
        MEMORY_ATOMS.write,
        span?.instanceId,
        { written: memories.length },
        "execution",
      );
    }
    const result = {
      consolidated: memories.length,
      discarded,
      failed,
      memories,
      pending: candidates.length - memories.length - discarded,
    };
    span?.end({
      counts: {
        consolidated: result.consolidated,
        discarded: result.discarded,
        failed: result.failed,
        pending: result.pending,
      },
    });
    return result;
  }

  public async forget(input: ForgetUnifiedMemoryInput): Promise<ForgetUnifiedMemoryResult> {
    const sessionId = requireIdentifier(input.sessionId, "Working Memory Session ID");
    const mode = input.mode ?? "soft";
    const records = await this.workingStore.list(sessionId);
    const working = records.find((record) => record.id === input.id);
    const span = startSpan(
      input.atomicFlow,
      MEMORY_ATOMS.forget,
      input.atomicParentInstanceId,
      "execution",
    );

    if (working !== undefined) {
      await this.workingStore.replace(
        sessionId,
        records.filter((record) => record.id !== working.id),
      );
      span?.end({ counts: { forgotten: 1, working: 1 } });
      return {
        forgotten: true,
        id: input.id,
        mode,
        tier: "working",
      };
    }

    const forgotten = await this.manager.forget({
      context: input.context,
      id: input.id,
      mode,
      signal: input.signal,
    });
    const forgottenCount = Number(forgotten);
    span?.end({ counts: { forgotten: forgottenCount, longTerm: forgottenCount } });
    return {
      forgotten,
      id: input.id,
      mode,
      ...(forgotten ? { tier: "long-term" as const } : {}),
    };
  }

  public async prune(input: PruneMemoriesInput): Promise<PruneMemoriesResult> {
    const span = startSpan(
      input.atomicFlow,
      MEMORY_ATOMS.prune,
      input.atomicParentInstanceId,
      "execution",
    );
    const result = await this.manager.prune({
      before: input.before,
      context: input.context,
      signal: input.signal,
    });
    span?.end({ counts: { deleted: result.deleted } });
    return result;
  }

  public async status(sessionId: string, context?: MemoryContext): Promise<MemoryLifecycleStatus> {
    const records = await this.workingStore.list(requireIdentifier(sessionId, "Session ID"));
    return {
      longTerm:
        context === undefined
          ? {
              procedure: 0,
              scenario: 0,
              semantic: 0,
            }
          : await this.manager.countByClass({ context }),
      pendingConsolidation: records.filter(
        (record) => record.status === "active" && record.draft !== undefined,
      ).length,
      working: records.filter((record) => record.status !== "discarded").length,
    };
  }

  public listWorking(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
    return this.workingStore.list(requireIdentifier(sessionId, "Session ID"));
  }

  public clearWorking(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
    return this.workingStore.replace(requireIdentifier(sessionId, "Session ID"), []);
  }

  private prepareContent(content: string): string {
    const validated = validateContent(content, this.policy);
    return validateContent(redactMemoryContent(validated, this.redactors).content, this.policy);
  }

  private prepareDraft(draft: NonNullable<WorkingMemoryRecord["draft"]>) {
    return Object.freeze({
      confidence: validateScore(draft.confidence, 0),
      content: this.prepareContent(draft.content),
      ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
      importance: validateScore(draft.importance, 0),
      kind: validateKind(draft.kind),
      ...(draft.metadata !== undefined
        ? { metadata: validateMetadata(draft.metadata, this.policy) }
        : {}),
      ...(draft.tags !== undefined ? { tags: validateTags(draft.tags, this.policy) } : {}),
    });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function searchWorking(
  records: readonly WorkingMemoryRecord[],
  query: string,
  limit: number,
): readonly Extract<MemorySearchResult, { readonly tier: "working" }>[] {
  const terms = tokenize(query);
  return records
    .filter((record) => record.status !== "discarded")
    .map((record) => ({
      class: "working" as const,
      content: record.content,
      reasons: ["WORKING_MATCH"] as const,
      score: lexicalScore(record.content, terms),
      tier: "working" as const,
      workingMemory: record,
    }))
    .filter((result) => result.score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.workingMemory.updatedAt.localeCompare(left.workingMemory.updatedAt),
    )
    .slice(0, limit);
}

function mergeResults(
  working: readonly Extract<MemorySearchResult, { readonly tier: "working" }>[],
  longTerm: readonly Extract<MemorySearchResult, { readonly tier: "long-term" }>[],
  limit: number,
  maxChars: number,
): readonly MemorySearchResult[] {
  const seen = new Set<string>();
  const selected: MemorySearchResult[] = [];
  let characters = 0;

  for (const result of [...working, ...longTerm].toSorted(
    (left, right) =>
      Number(right.tier === "working") - Number(left.tier === "working") ||
      right.score - left.score,
  )) {
    const kind =
      result.tier === "long-term"
        ? result.memory.kind
        : (result.workingMemory.draft?.kind ?? "fact");
    const fingerprint = createFingerprint(kind, normalizeContent(result.content));
    if (
      seen.has(fingerprint) ||
      selected.length >= limit ||
      characters + result.content.length > maxChars
    ) {
      continue;
    }
    seen.add(fingerprint);
    selected.push(result);
    characters += result.content.length;
  }
  return selected;
}

function normalizeClasses(
  classes: readonly MemorySearchClass[] | undefined,
): readonly MemorySearchClass[] {
  const values = classes ?? ["working", "semantic", "procedure", "scenario"];
  const allowed = new Set<MemorySearchClass>(["procedure", "scenario", "semantic", "working"]);
  if (values.some((value) => !allowed.has(value))) {
    throw new Error("Memory Search Class is invalid.");
  }
  return [...new Set(values)];
}

function kindsForClasses(classes: readonly MemoryClass[]) {
  return [
    ...(classes.includes("scenario") ? (["decision", "episode"] as const) : []),
    ...(classes.includes("procedure") ? (["procedure"] as const) : []),
    ...(classes.includes("semantic") ? (["fact", "preference"] as const) : []),
  ];
}

function tokenize(value: string): readonly string[] {
  return [
    ...new Set(
      normalizeContent(value)
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    ),
  ];
}

function lexicalScore(content: string, terms: readonly string[]): number {
  const normalized = normalizeContent(content).toLocaleLowerCase();
  return terms.length === 0
    ? 0
    : terms.filter((term) => normalized.includes(term)).length / terms.length;
}

function startSpan(
  flow: AtomicFlowRun | undefined,
  atom: AtomicDefinition,
  parentInstanceId: string | undefined,
  edgeKind: "data" | "execution" | "feedback",
): AtomicSpan | undefined {
  return flow?.start({
    atom,
    ...(parentInstanceId !== undefined
      ? {
          edge: {
            fromAtomKey: parentAtomKey(flow, parentInstanceId) ?? atom.key,
            kind: edgeKind,
            toAtomKey: atom.key,
          },
          parentInstanceId,
        }
      : {}),
  });
}

function emitCompleted(
  flow: AtomicFlowRun | undefined,
  atom: AtomicDefinition,
  parentInstanceId: string | undefined,
  counts: Readonly<Record<string, number>>,
  edgeKind: "data" | "execution" | "feedback",
): string | undefined {
  const span = startSpan(flow, atom, parentInstanceId, edgeKind);
  span?.end({ counts });
  return span?.instanceId;
}

function latestInstanceId(flow: AtomicFlowRun, atomKey: string): string | undefined {
  return flow.snapshot().events.findLast((event) => event.atom.key === atomKey)?.instance.id;
}

function parentAtomKey(flow: AtomicFlowRun, instanceId: string): string | undefined {
  return flow.snapshot().events.findLast((event) => event.instance.id === instanceId)?.atom.key;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workingMemorySourceLabel(source: WorkingMemorySource): string {
  switch (source) {
    case "operation":
      return "Operation";
    case "prompt":
      return "Prompt";
    case "task":
      return "Task";
    case "turn-extract":
      return "Turn Extract";
    case "user-answer":
      return "User Answer";
  }
}
