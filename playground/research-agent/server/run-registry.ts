import { randomUUID } from "node:crypto";
import type { AgentProgressEvent, AgentUsage } from "@yiku/agent-orchestrator";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { ResearchRunner } from "./research-runner.js";
import type {
  ResearchRunExecutor,
  ResearchRunSnapshot,
  ResearchRunStatus,
  ResearchRunSummary,
  RunStatusData,
  RunStreamEvent,
} from "./types.js";

const MAX_PROMPT_BYTES = 8 * 1024;

interface RunRecord {
  readonly abortController: AbortController;
  readonly createdAt: string;
  error?: string;
  readonly events: RunStreamEvent[];
  readonly listeners: Set<(event: RunStreamEvent) => void>;
  model?: string;
  output?: string;
  readonly prompt: string;
  readonly runId: string;
  status: ResearchRunStatus;
  streamedText: string;
  updatedAt: string;
  usage?: AgentUsage;
  validation?: ResearchRunSnapshot["validation"];
}

export interface RunRegistryOptions {
  readonly executor?: ResearchRunExecutor | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

export type CancelRunResult = "accepted" | "finished" | "not-found";

export class RunValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunValidationError";
  }
}

export class RunRegistry {
  private readonly executions = new Map<string, Promise<void>>();
  private readonly executor: ResearchRunExecutor;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly runs = new Map<string, RunRecord>();

  public constructor(options: RunRegistryOptions = {}) {
    this.executor = options.executor ?? new ResearchRunner();
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(promptInput: string): ResearchRunSummary {
    const prompt = normalizePrompt(promptInput);
    const occurredAt = this.now().toISOString();
    const runId = this.idGenerator();
    const record: RunRecord = {
      abortController: new AbortController(),
      createdAt: occurredAt,
      events: [],
      listeners: new Set(),
      prompt,
      runId,
      status: "queued",
      streamedText: "",
      updatedAt: occurredAt,
    };
    this.runs.set(runId, record);
    this.publishStatus(record, { status: "queued" });

    const execution = Promise.resolve()
      .then(() => this.execute(record))
      .finally(() => {
        this.executions.delete(runId);
      });
    this.executions.set(runId, execution);
    void execution;

    return this.summary(record);
  }

  public get(runId: string): ResearchRunSnapshot | undefined {
    const record = this.runs.get(runId);

    if (record === undefined) {
      return undefined;
    }

    return {
      createdAt: record.createdAt,
      ...(record.error !== undefined ? { error: record.error } : {}),
      events: [...record.events],
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(record.output !== undefined ? { output: record.output } : {}),
      prompt: record.prompt,
      runId: record.runId,
      status: record.status,
      streamedText: record.streamedText,
      updatedAt: record.updatedAt,
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
      ...(record.validation !== undefined ? { validation: record.validation } : {}),
    };
  }

  public events(runId: string, afterId = 0): readonly RunStreamEvent[] | undefined {
    const record = this.runs.get(runId);

    return record?.events.filter((event) => event.id > afterId);
  }

  public subscribe(
    runId: string,
    afterId: number,
    listener: (event: RunStreamEvent) => void,
  ): (() => void) | undefined {
    const record = this.runs.get(runId);

    if (record === undefined) {
      return undefined;
    }

    for (const event of record.events) {
      if (event.id > afterId) {
        listener(event);
      }
    }

    if (isTerminal(record.status)) {
      return () => undefined;
    }

    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  public cancel(runId: string): CancelRunResult {
    const record = this.runs.get(runId);

    if (record === undefined) {
      return "not-found";
    }
    if (isTerminal(record.status)) {
      return "finished";
    }

    record.abortController.abort(new Error("Research run cancelled."));
    return "accepted";
  }

  public async close(): Promise<void> {
    for (const record of this.runs.values()) {
      if (!isTerminal(record.status)) {
        record.abortController.abort(new Error("Research server closed."));
      }
    }

    await Promise.allSettled(this.executions.values());
    for (const record of this.runs.values()) {
      record.listeners.clear();
    }
  }

  private async execute(record: RunRecord): Promise<void> {
    this.publishStatus(record, { status: "running" });
    const atomicFlow = new AtomicFlowRun({ runId: record.runId });
    const unsubscribe = atomicFlow.subscribe((event) => {
      this.publish(record, {
        data: event,
        type: "flow",
      });
    });

    try {
      const result = await this.executor.execute({
        atomicFlow,
        onEvent: (event) => this.recordProgress(record, event),
        prompt: record.prompt,
        signal: record.abortController.signal,
        skill: "research",
      });
      record.model = result.model;

      if (record.abortController.signal.aborted || result.stopReason === "cancelled") {
        this.publishStatus(record, this.statusData(record, "cancelled"));
        return;
      }
      if (result.stopReason !== undefined && result.stopReason !== "completed") {
        record.error = `Research stopped before completion: ${result.stopReason}.`;
        this.publishStatus(record, this.statusData(record, "failed"));
        return;
      }

      if (result.usage !== undefined && !sameUsage(record.usage, result.usage)) {
        this.recordProgress(record, {
          model: result.model,
          type: "usage_updated",
          usage: result.usage,
        });
      }
      record.output = formatOutput(result.finalOutput);
      record.validation = result.validation;
      if (result.validation !== undefined && !result.validation.passed) {
        record.error = `Research report validation failed: ${result.validation.diagnostics.join("; ")}`;
        this.publishStatus(record, this.statusData(record, "failed"));
        return;
      }
      this.publishStatus(record, this.statusData(record, "completed"));
    } catch (error) {
      if (record.abortController.signal.aborted) {
        this.publishStatus(record, this.statusData(record, "cancelled"));
      } else {
        record.error = error instanceof Error ? error.message : String(error);
        this.publishStatus(record, this.statusData(record, "failed"));
      }
    } finally {
      unsubscribe();
      await atomicFlow.close();
    }
  }

  private recordProgress(record: RunRecord, event: AgentProgressEvent): void {
    if (event.type === "message_delta") {
      record.streamedText += event.text;
    } else if (event.type === "usage_updated") {
      record.usage = event.usage;
      record.model = event.model;
    }

    this.publish(record, {
      data: event,
      type: "progress",
    });
  }

  private publishStatus(record: RunRecord, data: RunStatusData): void {
    record.status = data.status;
    this.publish(record, {
      data,
      type: "status",
    });
  }

  private statusData(record: RunRecord, status: ResearchRunStatus): RunStatusData {
    return {
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(record.output !== undefined ? { output: record.output } : {}),
      status,
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
      ...(record.validation !== undefined ? { validation: record.validation } : {}),
    };
  }

  private publish(
    record: RunRecord,
    event:
      | Pick<Extract<RunStreamEvent, { type: "flow" }>, "data" | "type">
      | Pick<Extract<RunStreamEvent, { type: "progress" }>, "data" | "type">
      | Pick<Extract<RunStreamEvent, { type: "status" }>, "data" | "type">,
  ): void {
    const occurredAt = this.now().toISOString();
    const envelope = {
      ...event,
      id: record.events.length + 1,
      occurredAt,
      runId: record.runId,
    } as RunStreamEvent;
    record.events.push(envelope);
    record.updatedAt = occurredAt;

    for (const listener of record.listeners) {
      try {
        listener(envelope);
      } catch {
        // Observers cannot alter a research run.
      }
    }
  }

  private summary(record: RunRecord): ResearchRunSummary {
    return {
      createdAt: record.createdAt,
      prompt: record.prompt,
      runId: record.runId,
      status: record.status,
      updatedAt: record.updatedAt,
    };
  }
}

function normalizePrompt(input: string): string {
  const prompt = input.trim();

  if (!prompt) {
    throw new RunValidationError("Prompt is required.");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new RunValidationError("Prompt must not exceed 8 KiB.");
  }

  return prompt;
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
