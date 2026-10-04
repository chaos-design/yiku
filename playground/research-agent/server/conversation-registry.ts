import { randomUUID } from "node:crypto";
import type { AgentProgressEvent, AgentUsage } from "@yiku/agent-orchestrator";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import {
  MemoryResearchConversationStore,
  type ResearchConversationStore,
} from "./conversation-store.js";
import { ResearchRunner } from "./research-runner.js";
import type {
  ResearchConversationInputMessage,
  ResearchMessage,
  ResearchRunExecutor,
  ResearchRunStatus,
  ResearchSkillId,
  ResearchThreadSnapshot,
  ResearchThreadSummary,
  ResearchTurnOptions,
  ResearchTurnSnapshot,
  ResearchTurnSummary,
  RunStatusData,
  RunStreamEvent,
} from "./types.js";

const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_TITLE_LENGTH = 96;

interface TurnRecord {
  readonly abortController: AbortController;
  readonly createdAt: string;
  error?: string;
  readonly events: RunStreamEvent[];
  evidence: ResearchTurnSnapshot["evidence"];
  readonly listeners: Set<(event: RunStreamEvent) => void>;
  model?: string;
  readonly options: ResearchTurnOptions;
  output?: string;
  readonly prompt: string;
  readonly skill: ResearchSkillId;
  status: ResearchRunStatus;
  streamedText: string;
  readonly threadId: string;
  readonly turnId: string;
  updatedAt: string;
  usage?: AgentUsage;
  validation?: ResearchTurnSnapshot["validation"];
}

interface ThreadRecord {
  readonly createdAt: string;
  readonly messages: ResearchMessage[];
  status: ResearchThreadSnapshot["status"];
  readonly threadId: string;
  title: string;
  readonly turns: TurnRecord[];
  updatedAt: string;
}

export interface ConversationRegistryOptions {
  readonly createAtomicFlow?: ((input: ResearchAtomicFlowInput) => AtomicFlowRun) | undefined;
  readonly executor?: ResearchRunExecutor | undefined;
  readonly messageIdGenerator?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly store?: ResearchConversationStore | undefined;
  readonly threadIdGenerator?: (() => string) | undefined;
  readonly turnIdGenerator?: (() => string) | undefined;
}

export interface ResearchAtomicFlowInput {
  readonly prompt: string;
  readonly skill: ResearchSkillId;
  readonly threadId: string;
  readonly turnId: string;
}

export type CancelTurnResult = "accepted" | "finished" | "not-found";
export type DeleteThreadResult = "deleted" | "not-found";

export class ConversationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConversationValidationError";
  }
}

export class ConversationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConversationConflictError";
  }
}

export class ConversationRegistry {
  private readonly createAtomicFlow: (input: ResearchAtomicFlowInput) => AtomicFlowRun;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly executor: ResearchRunExecutor;
  private initialized = false;
  private readonly messageIdGenerator: () => string;
  private readonly now: () => Date;
  private persistence = Promise.resolve();
  private readonly store: ResearchConversationStore;
  private readonly threadIdGenerator: () => string;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly turnIdGenerator: () => string;
  private readonly turns = new Map<string, TurnRecord>();

  public constructor(options: ConversationRegistryOptions = {}) {
    this.createAtomicFlow =
      options.createAtomicFlow ?? ((input) => new AtomicFlowRun({ runId: input.turnId }));
    this.executor = options.executor ?? new ResearchRunner();
    this.messageIdGenerator = options.messageIdGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new MemoryResearchConversationStore();
    this.threadIdGenerator = options.threadIdGenerator ?? randomUUID;
    this.turnIdGenerator = options.turnIdGenerator ?? randomUUID;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const restored = await this.store.load();
    let recovered = false;
    for (const snapshot of restored) {
      const thread = this.restoreThread(snapshot);
      this.threads.set(thread.threadId, thread);
      for (const turn of thread.turns) {
        this.turns.set(turn.turnId, turn);
        if (!isTerminal(turn.status)) {
          recovered = true;
          turn.error = "Research turn was interrupted by a server restart.";
          turn.status = "failed";
          turn.updatedAt = this.now().toISOString();
          thread.status = "failed";
          thread.updatedAt = turn.updatedAt;
          this.appendStatusEvent(turn, this.statusData(turn, "failed"));
        }
      }
    }
    this.initialized = true;
    if (recovered) {
      await this.persist();
    }
  }

  public listThreads(): readonly ResearchThreadSummary[] {
    this.requireInitialized();
    return [...this.threads.values()]
      .map((thread) => this.threadSummary(thread))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public getThread(threadId: string): ResearchThreadSnapshot | undefined {
    this.requireInitialized();
    const thread = this.threads.get(threadId);
    return thread === undefined ? undefined : this.threadSnapshot(thread);
  }

  public getTurn(turnId: string): ResearchTurnSnapshot | undefined {
    this.requireInitialized();
    const turn = this.turns.get(turnId);
    return turn === undefined ? undefined : this.turnSnapshot(turn);
  }

  public async createThread(titleInput?: string): Promise<ResearchThreadSummary> {
    this.requireInitialized();
    const occurredAt = this.now().toISOString();
    const threadId = requireId(this.threadIdGenerator(), "Thread ID");
    const thread: ThreadRecord = {
      createdAt: occurredAt,
      messages: [],
      status: "idle",
      threadId,
      title: normalizeTitle(titleInput),
      turns: [],
      updatedAt: occurredAt,
    };
    this.threads.set(threadId, thread);
    try {
      await this.persist();
    } catch (error) {
      if (this.threads.get(threadId) === thread) {
        this.threads.delete(threadId);
      }
      throw error;
    }
    return this.threadSummary(thread);
  }

  public async addMessage(
    threadId: string,
    promptInput: string,
    skill: ResearchSkillId = "research",
    options: ResearchTurnOptions = {},
  ): Promise<ResearchTurnSummary> {
    this.requireInitialized();
    const thread = this.threads.get(threadId);
    if (thread === undefined) {
      throw new ConversationValidationError("Research thread not found.");
    }
    if (thread.turns.some((turn) => !isTerminal(turn.status))) {
      throw new ConversationConflictError("Research thread already has an active turn.");
    }
    const prompt = normalizePrompt(promptInput);
    const occurredAt = this.now().toISOString();
    const messageId = requireId(this.messageIdGenerator(), "Message ID");
    const turnId = requireId(this.turnIdGenerator(), "Turn ID");
    const previousThreadState = {
      status: thread.status,
      title: thread.title,
      updatedAt: thread.updatedAt,
    };
    const turn: TurnRecord = {
      abortController: new AbortController(),
      createdAt: occurredAt,
      events: [],
      evidence: [],
      listeners: new Set(),
      options: { ...options },
      prompt,
      skill,
      status: "queued",
      streamedText: "",
      threadId,
      turnId,
      updatedAt: occurredAt,
    };
    thread.messages.push({
      content: prompt,
      createdAt: occurredAt,
      messageId,
      role: "user",
      turnId,
    });
    thread.turns.push(turn);
    thread.status = "queued";
    thread.updatedAt = occurredAt;
    if (thread.messages.length === 1 && thread.title === "New research") {
      thread.title = prompt.slice(0, MAX_TITLE_LENGTH);
    }
    this.turns.set(turnId, turn);
    this.publishStatus(turn, { status: "queued" });
    // #region debug-point E:persist-start
    void fetch("http://127.0.0.1:7777/event", {
      body: JSON.stringify({
        data: { fileStore: this.store.constructor.name, pid: process.pid, status: turn.status },
        hypothesisId: "E",
        location: "conversation-registry.ts:addMessage:persist-start",
        msg: "[DEBUG] Persisting queued turn",
        runId: "post-fix",
        sessionId: "research-turn-queued",
        traceId: turnId,
        ts: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
    // #endregion
    try {
      await this.persist();
    } catch (error) {
      // #region debug-point E:persist-failed
      void fetch("http://127.0.0.1:7777/event", {
        body: JSON.stringify({
          data: {
            error: error instanceof Error ? error.message : String(error),
            pid: process.pid,
            status: turn.status,
          },
          hypothesisId: "E",
          location: "conversation-registry.ts:addMessage:persist-failed",
          msg: "[DEBUG] Queued turn persistence failed",
          runId: "post-fix",
          sessionId: "research-turn-queued",
          traceId: turnId,
          ts: Date.now(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => {});
      // #endregion
      const messageIndex = thread.messages.findIndex((message) => message.messageId === messageId);
      if (messageIndex >= 0) {
        thread.messages.splice(messageIndex, 1);
      }
      const turnIndex = thread.turns.findIndex((candidate) => candidate.turnId === turnId);
      if (turnIndex >= 0) {
        thread.turns.splice(turnIndex, 1);
      }
      this.turns.delete(turnId);
      thread.status = previousThreadState.status;
      thread.title = previousThreadState.title;
      thread.updatedAt = previousThreadState.updatedAt;
      throw error;
    }

    // #region debug-point A:after-persist
    void fetch("http://127.0.0.1:7777/event", {
      body: JSON.stringify({
        data: { eventCount: turn.events.length, pid: process.pid, status: turn.status },
        hypothesisId: "A",
        location: "conversation-registry.ts:addMessage:after-persist",
        msg: "[DEBUG] Queued turn persisted",
        runId: "post-fix",
        sessionId: "research-turn-queued",
        traceId: turnId,
        ts: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
    // #endregion
    const execution = Promise.resolve()
      .then(() => {
        // #region debug-point A:promise-callback
        void fetch("http://127.0.0.1:7777/event", {
          body: JSON.stringify({
            data: { eventCount: turn.events.length, pid: process.pid, status: turn.status },
            hypothesisId: "A",
            location: "conversation-registry.ts:addMessage:promise-callback",
            msg: "[DEBUG] Execution Promise callback entered",
            runId: "post-fix",
            sessionId: "research-turn-queued",
            traceId: turnId,
            ts: Date.now(),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => {});
        // #endregion
        return this.execute(thread, turn);
      })
      .catch((error: unknown) => {
        // #region debug-point B:execution-chain-catch
        void fetch("http://127.0.0.1:7777/event", {
          body: JSON.stringify({
            data: {
              error: error instanceof Error ? error.message : String(error),
              pid: process.pid,
              status: turn.status,
            },
            hypothesisId: "B",
            location: "conversation-registry.ts:addMessage:execution-catch",
            msg: "[DEBUG] Execution Promise rejected",
            runId: "post-fix",
            sessionId: "research-turn-queued",
            traceId: turnId,
            ts: Date.now(),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => {});
        // #endregion
        turn.error = `Research conversation persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publishStatus(turn, this.statusData(turn, "failed"));
      })
      .finally(() => {
        this.executions.delete(turnId);
      });
    this.executions.set(turnId, execution);
    void execution;
    return this.turnSummary(turn);
  }

  public async deleteThread(threadId: string): Promise<DeleteThreadResult> {
    this.requireInitialized();
    const thread = this.threads.get(threadId);
    if (thread === undefined) {
      return "not-found";
    }
    for (const turn of thread.turns) {
      if (!isTerminal(turn.status)) {
        turn.abortController.abort(new Error("Research thread deleted."));
      }
      turn.listeners.clear();
      this.turns.delete(turn.turnId);
    }
    this.threads.delete(threadId);
    await this.persist();
    return "deleted";
  }

  public subscribeTurn(
    turnId: string,
    afterId: number,
    listener: (event: RunStreamEvent) => void,
  ): (() => void) | undefined {
    this.requireInitialized();
    const turn = this.turns.get(turnId);
    if (turn === undefined) {
      return undefined;
    }
    for (const event of turn.events) {
      if (event.id > afterId) {
        listener(event);
      }
    }
    if (isTerminal(turn.status)) {
      return () => undefined;
    }
    turn.listeners.add(listener);
    return () => {
      turn.listeners.delete(listener);
    };
  }

  public cancelTurn(turnId: string): CancelTurnResult {
    this.requireInitialized();
    const turn = this.turns.get(turnId);
    if (turn === undefined) {
      return "not-found";
    }
    if (isTerminal(turn.status)) {
      return "finished";
    }
    turn.abortController.abort(new Error("Research turn cancelled."));
    return "accepted";
  }

  public async close(): Promise<void> {
    for (const turn of this.turns.values()) {
      if (!isTerminal(turn.status)) {
        turn.abortController.abort(new Error("Research conversation server closed."));
      }
    }
    await Promise.allSettled(this.executions.values());
    await this.persistence;
    for (const turn of this.turns.values()) {
      turn.listeners.clear();
    }
  }

  private async execute(thread: ThreadRecord, turn: TurnRecord): Promise<void> {
    // #region debug-point B:execute-entry
    void fetch("http://127.0.0.1:7777/event", {
      body: JSON.stringify({
        data: { eventCount: turn.events.length, pid: process.pid, status: turn.status },
        hypothesisId: "B",
        location: "conversation-registry.ts:execute:entry",
        msg: "[DEBUG] Execute entered",
        runId: "post-fix",
        sessionId: "research-turn-queued",
        traceId: turn.turnId,
        ts: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
    // #endregion
    this.publishStatus(turn, { status: "running" });
    // #region debug-point C:running-published
    void fetch("http://127.0.0.1:7777/event", {
      body: JSON.stringify({
        data: { eventCount: turn.events.length, pid: process.pid, status: turn.status },
        hypothesisId: "C",
        location: "conversation-registry.ts:execute:running-published",
        msg: "[DEBUG] Running status published",
        runId: "post-fix",
        sessionId: "research-turn-queued",
        traceId: turn.turnId,
        ts: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
    // #endregion
    const atomicFlow = this.createAtomicFlow({
      prompt: turn.prompt,
      skill: turn.skill,
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    const unsubscribe = atomicFlow.subscribe((event) => {
      this.publish(turn, {
        data: event,
        type: "flow",
      });
    });
    const history = conversationHistory(thread, turn.turnId);

    try {
      const result = await this.executor.execute({
        atomicFlow,
        history,
        ...(turn.options.instructions !== undefined
          ? { instructions: turn.options.instructions }
          : {}),
        onEvent: (event) => this.recordProgress(turn, event),
        prompt: turn.prompt,
        ...(turn.options.searchContextSize !== undefined
          ? { searchContextSize: turn.options.searchContextSize }
          : {}),
        signal: turn.abortController.signal,
        skill: turn.skill,
      });
      turn.model = result.model;
      turn.evidence = result.evidence ?? [];

      if (turn.abortController.signal.aborted || result.stopReason === "cancelled") {
        this.appendAssistantMessage(thread, turn, turn.streamedText);
        this.publishStatus(turn, this.statusData(turn, "cancelled"));
        return;
      }
      if (result.stopReason !== undefined && result.stopReason !== "completed") {
        turn.error = `Research stopped before completion: ${result.stopReason}.`;
        this.appendAssistantMessage(thread, turn, turn.streamedText);
        this.publishStatus(turn, this.statusData(turn, "failed"));
        return;
      }
      if (result.usage !== undefined && !sameUsage(turn.usage, result.usage)) {
        this.recordProgress(turn, {
          model: result.model,
          type: "usage_updated",
          usage: result.usage,
        });
      }
      turn.output = formatOutput(result.finalOutput);
      turn.validation = result.validation;
      this.appendAssistantMessage(thread, turn, turn.output);
      if (result.validation !== undefined && !result.validation.passed) {
        turn.error = `Research report validation failed: ${result.validation.diagnostics.join("; ")}`;
        this.publishStatus(turn, this.statusData(turn, "failed"));
        return;
      }
      this.publishStatus(turn, this.statusData(turn, "completed"));
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        this.appendAssistantMessage(thread, turn, turn.streamedText);
        this.publishStatus(turn, this.statusData(turn, "cancelled"));
      } else {
        turn.error = error instanceof Error ? error.message : String(error);
        this.appendAssistantMessage(thread, turn, turn.streamedText);
        this.publishStatus(turn, this.statusData(turn, "failed"));
      }
    } finally {
      unsubscribe();
      await atomicFlow.close();
      await this.persist();
    }
  }

  private recordProgress(turn: TurnRecord, event: AgentProgressEvent): void {
    if (event.type === "message_delta") {
      turn.streamedText += event.text;
    } else if (event.type === "usage_updated") {
      turn.usage = event.usage;
      turn.model = event.model;
    }
    this.publish(turn, {
      data: event,
      type: "progress",
    });
  }

  private appendAssistantMessage(thread: ThreadRecord, turn: TurnRecord, content: string): void {
    const normalized = content.trim();
    if (
      !normalized ||
      thread.messages.some(
        (message) => message.turnId === turn.turnId && message.role === "assistant",
      )
    ) {
      return;
    }
    const occurredAt = this.now().toISOString();
    thread.messages.push({
      content: normalized,
      createdAt: occurredAt,
      messageId: requireId(this.messageIdGenerator(), "Message ID"),
      role: "assistant",
      turnId: turn.turnId,
    });
    thread.updatedAt = occurredAt;
  }

  private publishStatus(turn: TurnRecord, data: RunStatusData): void {
    // #region debug-point C:status-transition
    void fetch("http://127.0.0.1:7777/event", {
      body: JSON.stringify({
        data: {
          eventCount: turn.events.length,
          from: turn.status,
          pid: process.pid,
          to: data.status,
        },
        hypothesisId: "C",
        location: "conversation-registry.ts:publishStatus",
        msg: "[DEBUG] Status transition requested",
        runId: "post-fix",
        sessionId: "research-turn-queued",
        traceId: turn.turnId,
        ts: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => {});
    // #endregion
    turn.status = data.status;
    const thread = this.threads.get(turn.threadId);
    if (thread !== undefined) {
      thread.status = data.status;
    }
    this.publish(turn, {
      data,
      type: "status",
    });
  }

  private appendStatusEvent(turn: TurnRecord, data: RunStatusData): void {
    const occurredAt = this.now().toISOString();
    turn.events.push({
      data,
      id: turn.events.length + 1,
      occurredAt,
      runId: turn.turnId,
      type: "status",
    });
  }

  private statusData(turn: TurnRecord, status: ResearchRunStatus): RunStatusData {
    return {
      ...(turn.error !== undefined ? { error: turn.error } : {}),
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.output !== undefined ? { output: turn.output } : {}),
      status,
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      ...(turn.validation !== undefined ? { validation: turn.validation } : {}),
    };
  }

  private publish(
    turn: TurnRecord,
    event:
      | Pick<Extract<RunStreamEvent, { type: "flow" }>, "data" | "type">
      | Pick<Extract<RunStreamEvent, { type: "progress" }>, "data" | "type">
      | Pick<Extract<RunStreamEvent, { type: "status" }>, "data" | "type">,
  ): void {
    const occurredAt = this.now().toISOString();
    const envelope = {
      ...event,
      id: turn.events.length + 1,
      occurredAt,
      runId: turn.turnId,
    } as RunStreamEvent;
    turn.events.push(envelope);
    turn.updatedAt = occurredAt;
    const thread = this.threads.get(turn.threadId);
    if (thread !== undefined) {
      thread.updatedAt = occurredAt;
    }
    for (const listener of turn.listeners) {
      try {
        listener(envelope);
      } catch {
        // Observers cannot alter a Research Turn.
      }
    }
  }

  private async persist(): Promise<void> {
    const snapshot = [...this.threads.values()].map((thread) => this.threadSnapshot(thread));
    const save = this.persistence.then(() => this.store.save(snapshot));
    this.persistence = save.catch(() => undefined);
    await save;
  }

  private restoreThread(snapshot: ResearchThreadSnapshot): ThreadRecord {
    const turns = snapshot.turns.map((turn) => this.restoreTurn(turn));
    return {
      createdAt: snapshot.createdAt,
      messages: [...snapshot.messages],
      status: snapshot.status,
      threadId: snapshot.threadId,
      title: snapshot.title,
      turns,
      updatedAt: snapshot.updatedAt,
    };
  }

  private restoreTurn(snapshot: ResearchTurnSnapshot): TurnRecord {
    return {
      abortController: new AbortController(),
      createdAt: snapshot.createdAt,
      ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
      events: [...snapshot.events],
      evidence: [...snapshot.evidence],
      listeners: new Set(),
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      options: {},
      ...(snapshot.output !== undefined ? { output: snapshot.output } : {}),
      prompt: snapshot.prompt,
      skill: normalizeResearchSkill(snapshot.skill),
      status: snapshot.status,
      streamedText: snapshot.streamedText,
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      updatedAt: snapshot.updatedAt,
      ...(snapshot.usage !== undefined ? { usage: snapshot.usage } : {}),
      ...(snapshot.validation !== undefined ? { validation: snapshot.validation } : {}),
    };
  }

  private threadSummary(thread: ThreadRecord): ResearchThreadSummary {
    const lastMessage = thread.messages.at(-1)?.content;
    return {
      createdAt: thread.createdAt,
      ...(lastMessage !== undefined ? { lastMessage: lastMessage.slice(0, 180) } : {}),
      messageCount: thread.messages.length,
      status: thread.status,
      threadId: thread.threadId,
      title: thread.title,
      updatedAt: thread.updatedAt,
    };
  }

  private threadSnapshot(thread: ThreadRecord): ResearchThreadSnapshot {
    return {
      ...this.threadSummary(thread),
      messages: thread.messages.map((message) => ({ ...message })),
      turns: thread.turns.map((turn) => this.turnSnapshot(turn)),
    };
  }

  private turnSummary(turn: TurnRecord): ResearchTurnSummary {
    return {
      createdAt: turn.createdAt,
      prompt: turn.prompt,
      skill: turn.skill,
      status: turn.status,
      threadId: turn.threadId,
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
    };
  }

  private turnSnapshot(turn: TurnRecord): ResearchTurnSnapshot {
    return {
      ...this.turnSummary(turn),
      ...(turn.error !== undefined ? { error: turn.error } : {}),
      events: [...turn.events],
      evidence: [...turn.evidence],
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.output !== undefined ? { output: turn.output } : {}),
      streamedText: turn.streamedText,
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      ...(turn.validation !== undefined ? { validation: turn.validation } : {}),
    };
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("Research conversation registry is not initialized.");
    }
  }
}

function conversationHistory(
  thread: ThreadRecord,
  activeTurnId: string,
): readonly ResearchConversationInputMessage[] {
  return thread.messages
    .filter((message) => message.turnId !== activeTurnId)
    .map(({ content, role }) => ({ content, role }));
}

function normalizePrompt(input: string): string {
  const prompt = input.trim();
  if (!prompt) {
    throw new ConversationValidationError("Prompt is required.");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new ConversationValidationError("Prompt must not exceed 8 KiB.");
  }
  return prompt;
}

function normalizeResearchSkill(value: unknown): ResearchSkillId {
  return value === "quick-research" || value === "deep-research" || value === "research"
    ? value
    : "research";
}

function normalizeTitle(input: string | undefined): string {
  const title = input?.trim() || "New research";
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ConversationValidationError(
      `Thread title must not exceed ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  return title;
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!id || id.length > 128) {
    throw new ConversationValidationError(`${label} is invalid.`);
  }
  return id;
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (output === undefined || output === null) {
    return "";
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function isTerminal(status: ResearchRunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function sameUsage(left: AgentUsage | undefined, right: AgentUsage): boolean {
  return (
    left?.cachedInputTokens === right.cachedInputTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.peakInputTokens === right.peakInputTokens &&
    left.totalTokens === right.totalTokens
  );
}
