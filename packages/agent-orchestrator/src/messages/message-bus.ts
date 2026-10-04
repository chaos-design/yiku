import type {
  AgentMessageEnvelope,
  AgentMessageSink,
  AgentMessageSinkRegistration,
} from "./types.js";

export interface AgentMessageBusOptions {
  readonly onOptionalSinkError?:
    | ((error: Error, message: AgentMessageEnvelope) => Promise<void> | void)
    | undefined;
  readonly sinks: readonly AgentMessageSinkRegistration[];
}

export class AgentMessageBus {
  private readonly listeners = new Set<AgentMessageSink>();
  private readonly onOptionalSinkError: AgentMessageBusOptions["onOptionalSinkError"];
  private readonly optionalSinks: readonly AgentMessageSinkRegistration[];
  private readonly queues = new Map<string, Promise<void>>();
  private readonly requiredSinks: readonly AgentMessageSinkRegistration[];

  public constructor(options: AgentMessageBusOptions) {
    this.onOptionalSinkError = options.onOptionalSinkError;
    this.optionalSinks = options.sinks.filter((sink) => sink.kind === "optional");
    this.requiredSinks = options.sinks.filter((sink) => sink.kind === "required");
  }

  public subscribe(listener: AgentMessageSink["publish"]): () => void {
    const registration: AgentMessageSink = { publish: listener };
    this.listeners.add(registration);
    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(registration);
    };
  }

  public publish(message: AgentMessageEnvelope): Promise<void> {
    const previous = this.queues.get(message.agentId) ?? Promise.resolve();
    const publication = previous.catch(() => undefined).then(() => this.dispatch(message));
    this.queues.set(message.agentId, publication);
    void publication.then(
      () => this.clearQueue(message.agentId, publication),
      () => this.clearQueue(message.agentId, publication),
    );
    return publication;
  }

  public async flush(agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      const queue = this.queues.get(agentId);
      if (queue !== undefined) {
        await queue;
      }
      return;
    }

    const queues = [...this.queues.values()];
    const results = await Promise.allSettled(queues);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  private clearQueue(agentId: string, publication: Promise<void>): void {
    if (this.queues.get(agentId) === publication) {
      this.queues.delete(agentId);
    }
  }

  private async dispatch(message: AgentMessageEnvelope): Promise<void> {
    const listeners = [...this.listeners];
    for (const sink of this.requiredSinks) {
      await sink.publish(message);
    }

    const optionalResults = await Promise.allSettled(
      [...this.optionalSinks, ...listeners].map((sink) =>
        Promise.resolve().then(() => sink.publish(message)),
      ),
    );
    for (const result of optionalResults) {
      if (result.status === "rejected") {
        await this.reportOptionalSinkError(toError(result.reason), message);
      }
    }
  }

  private async reportOptionalSinkError(
    error: Error,
    message: AgentMessageEnvelope,
  ): Promise<void> {
    try {
      await this.onOptionalSinkError?.(error, message);
    } catch {
      // Optional sink diagnostics must not make publication fail.
    }
  }
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error("Optional Agent Message sink failed.", { cause: reason });
}
