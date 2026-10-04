import { randomUUID } from "node:crypto";
import { FLOW_ATOMS } from "./atoms.js";
import { AtomicFlowError } from "./errors.js";
import type {
  AtomicEventDraft,
  AtomicFlowEvent,
  AtomicFlowRunOptions,
  AtomicFlowSink,
  AtomicFlowSnapshot,
  AtomicFlowSubscriber,
  AtomicPayloadSummary,
  AtomicPhase,
  AtomicSinkReceiptDraft,
  AtomicSpanInput,
} from "./types.js";

interface SinkState {
  queue: Promise<void>;
  readonly sink: AtomicFlowSink;
}

export class AtomicFlowRun {
  private readonly bufferedEvents: AtomicFlowEvent[] = [];
  private closed = false;
  private closing = false;
  private readonly clock: () => Date;
  private readonly degradationCodes = new Set<string>();
  private readonly eventIdGenerator: () => string;
  private readonly instanceIdGenerator: () => string;
  private readonly maxBufferedEvents: number;
  private sequence = 0;
  private readonly sinkStates: readonly SinkState[];
  private readonly subscribers = new Set<AtomicFlowSubscriber>();
  private readonly trace: boolean;

  public readonly runId: string;

  public constructor(options: AtomicFlowRunOptions) {
    this.runId = requireText(options.runId, "Atomic flow run ID");
    this.clock = options.clock ?? (() => new Date());
    this.eventIdGenerator = options.eventIdGenerator ?? randomUUID;
    this.instanceIdGenerator = options.instanceIdGenerator ?? randomUUID;
    this.maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
    this.trace = options.trace ?? false;

    if (!Number.isSafeInteger(this.maxBufferedEvents) || this.maxBufferedEvents <= 0) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_INVALID_RUN",
        "Atomic flow buffer size must be a positive integer.",
      );
    }

    const sinkIds = new Set<string>();
    this.sinkStates = (options.sinks ?? []).map((sink) => {
      const id = requireText(sink.id, "Atomic flow sink ID");

      if (sinkIds.has(id)) {
        throw new AtomicFlowError(
          "ATOMIC_FLOW_INVALID_RUN",
          `Duplicate atomic flow sink ID: ${id}.`,
        );
      }

      sinkIds.add(id);
      return {
        queue: Promise.resolve(),
        sink,
      };
    });
  }

  public emit(draft: AtomicEventDraft): AtomicFlowEvent {
    if (this.closed || this.closing) {
      throw new AtomicFlowError("ATOMIC_FLOW_CLOSED", "Atomic flow run is closed.");
    }

    return this.emitDraft(draft);
  }

  public start(input: AtomicSpanInput): AtomicSpan {
    const instanceId = input.instanceId ?? this.instanceIdGenerator();
    const baseDraft = {
      atom: input.atom,
      ...(input.edge !== undefined ? { edge: input.edge } : {}),
      instance: {
        id: instanceId,
        ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
        ...(input.parentInstanceId !== undefined ? { parentId: input.parentInstanceId } : {}),
      },
    };
    const event = this.emit({
      ...baseDraft,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      phase: "start",
    });

    return new AtomicSpan(this, baseDraft, event);
  }

  public schedule(input: AtomicSpanInput): AtomicFlowEvent {
    return this.emit({
      atom: input.atom,
      ...(input.edge !== undefined ? { edge: input.edge } : {}),
      instance: {
        id: input.instanceId ?? this.instanceIdGenerator(),
        ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
        ...(input.parentInstanceId !== undefined ? { parentId: input.parentInstanceId } : {}),
      },
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      phase: "scheduled",
    });
  }

  public subscribe(subscriber: AtomicFlowSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  public snapshot(): AtomicFlowSnapshot {
    return {
      degraded: this.degradationCodes.size > 0,
      degradationCodes: [...this.degradationCodes].sort(),
      events: [...this.bufferedEvents],
      runId: this.runId,
    };
  }

  public async flush(): Promise<void> {
    for (;;) {
      const queues = this.sinkStates.map((state) => state.queue);
      await Promise.all(queues);

      if (queues.every((queue, index) => queue === this.sinkStates[index]?.queue)) {
        return;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closing = true;
    await this.flush();
    await Promise.all(this.sinkStates.map((state) => state.sink.close?.()));
    this.closed = true;
  }

  private emitDraft(draft: AtomicEventDraft, skipSinkId?: string): AtomicFlowEvent {
    validateDraft(draft);
    this.sequence += 1;
    const event: AtomicFlowEvent = {
      atom: draft.atom,
      ...(draft.edge !== undefined ? { edge: draft.edge } : {}),
      eventId: this.eventIdGenerator(),
      instance: draft.instance,
      ...(draft.internal !== undefined ? { internal: draft.internal } : {}),
      occurredAt: this.clock().toISOString(),
      ...(draft.payload !== undefined ? { payload: draft.payload } : {}),
      phase: draft.phase,
      runId: this.runId,
      sequence: this.sequence,
    };

    this.bufferedEvents.push(event);
    if (this.bufferedEvents.length > this.maxBufferedEvents) {
      this.bufferedEvents.shift();
    }

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // Observers cannot alter execution.
      }
    }

    for (const state of this.sinkStates) {
      if (state.sink.id !== skipSinkId) {
        this.enqueueSink(state, event);
      }
    }

    return event;
  }

  private enqueueSink(state: SinkState, event: AtomicFlowEvent): void {
    state.queue = state.queue
      .then(async () => {
        const receipt = await state.sink.write(event);
        if (
          receipt !== undefined &&
          event.internal !== true &&
          (this.trace || !isTraceReceipt(receipt))
        ) {
          this.emitReceipt(receipt, event);
        }
      })
      .catch((error: unknown) => {
        const code = `ATOMIC_SINK_${state.sink.id.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
        this.degradationCodes.add(code);

        if (event.internal !== true && !this.closed && this.trace) {
          this.emitDraft(
            {
              atom: FLOW_ATOMS.sinkError,
              instance: {
                id: this.instanceIdGenerator(),
                parentId: event.instance.id,
              },
              internal: true,
              payload: {
                code: "ATOMIC_FLOW_SINK_FAILED",
                summary: error instanceof Error ? error.message : String(error),
                values: {
                  sinkId: state.sink.id,
                },
              },
              phase: "error",
            },
            state.sink.id,
          );
        }
      });
  }

  private emitReceipt(receipt: AtomicSinkReceiptDraft, source: AtomicFlowEvent): void {
    this.emitDraft({
      atom: receipt.atom,
      edge: {
        fromAtomKey: source.atom.key,
        fromInstanceId: source.instance.id,
        kind: "persistence",
        toAtomKey: receipt.atom.key,
      },
      instance: {
        id: this.instanceIdGenerator(),
        parentId: source.instance.id,
      },
      internal: true,
      ...(receipt.payload !== undefined ? { payload: receipt.payload } : {}),
      phase: receipt.phase ?? "end",
    });
  }
}

function isTraceReceipt(receipt: AtomicSinkReceiptDraft): boolean {
  return receipt.atom.kind === "trace" || receipt.atom.kind === "trajectory";
}

export class AtomicSpan {
  private ended = false;

  public constructor(
    private readonly flow: AtomicFlowRun,
    private readonly base: Pick<AtomicEventDraft, "atom" | "edge" | "instance">,
    public readonly startEvent: AtomicFlowEvent,
  ) {}

  public get instanceId(): string {
    return this.base.instance.id;
  }

  public delta(payload?: AtomicPayloadSummary): AtomicFlowEvent {
    return this.publish("delta", payload);
  }

  public end(payload?: AtomicPayloadSummary): AtomicFlowEvent {
    return this.finish("end", payload);
  }

  public fail(payload?: AtomicPayloadSummary): AtomicFlowEvent {
    return this.finish("error", payload);
  }

  public skip(payload?: AtomicPayloadSummary): AtomicFlowEvent {
    return this.finish("skipped", payload);
  }

  private finish(
    phase: "end" | "error" | "skipped",
    payload?: AtomicPayloadSummary,
  ): AtomicFlowEvent {
    if (this.ended) {
      throw new AtomicFlowError(
        "ATOMIC_FLOW_INVALID_EVENT",
        `Atomic span ${this.instanceId} has already ended.`,
      );
    }
    this.ended = true;
    return this.publish(phase, payload);
  }

  private publish(phase: AtomicPhase, payload?: AtomicPayloadSummary): AtomicFlowEvent {
    return this.flow.emit({
      ...this.base,
      ...(payload !== undefined ? { payload } : {}),
      phase,
    });
  }
}

function validateDraft(draft: AtomicEventDraft): void {
  requireText(draft.atom.key, "Atomic key");
  requireText(draft.atom.label, "Atomic label");
  requireText(draft.instance.id, "Atomic instance ID");

  if (
    draft.instance.iteration !== undefined &&
    (!Number.isSafeInteger(draft.instance.iteration) || draft.instance.iteration <= 0)
  ) {
    throw new AtomicFlowError(
      "ATOMIC_FLOW_INVALID_INSTANCE",
      "Atomic iteration must be a positive integer.",
    );
  }

  if (draft.edge !== undefined) {
    requireText(draft.edge.fromAtomKey, "Atomic edge source");
    requireText(draft.edge.toAtomKey, "Atomic edge target");
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AtomicFlowError("ATOMIC_FLOW_INVALID_ATOM", `${name} must be non-empty.`);
  }
  return value.trim();
}
