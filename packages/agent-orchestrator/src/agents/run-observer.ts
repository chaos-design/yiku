import { randomUUID } from "node:crypto";
import type { Agent } from "@openai/agents";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import { RUNTIME_ATOMS } from "../runtime/atoms.js";
import type { AgentProgressEvent, AgentRunValidation, AgentStopReason } from "../runtime/types.js";
import { getAgentGraphMembers, getAgentRuntimeMetadata } from "./agent-runtime-metadata.js";
import { boundedSummary } from "./bounded-summary.js";
import type { AgentObservabilityContext, AgentRunObserver } from "./types.js";

interface ObserverEntry {
  closed: boolean;
  degraded: boolean;
  readonly factory: NonNullable<ReturnType<typeof getAgentRuntimeMetadata>>["createRunObserver"];
  readonly identity: NonNullable<ReturnType<typeof getAgentRuntimeMetadata>>["identity"];
  observer?: AgentRunObserver | undefined;
  outputHandled: boolean;
  started: boolean;
  terminal: boolean;
  readonly validateOutput: NonNullable<
    ReturnType<typeof getAgentRuntimeMetadata>
  >["validateOutput"];
}

export interface CreateAgentGraphRunObserverOptions {
  readonly atomicFlow: AtomicFlowRun;
  readonly parentInstanceId: string;
  readonly prompt: string;
  readonly runId: string;
}

export class AgentGraphRunObserver {
  private activeAgentId: string | undefined;
  private closed = false;
  private readonly entries = new Map<string, ObserverEntry>();
  private readonly orderedEntries: ObserverEntry[] = [];

  public constructor(
    root: Agent,
    private readonly options: CreateAgentGraphRunObserverOptions,
  ) {
    for (const agent of getAgentGraphMembers(root)) {
      const metadata = getAgentRuntimeMetadata(agent);
      if (metadata === undefined) {
        continue;
      }
      if (this.entries.has(metadata.identity.agentId)) {
        throw new Error(`Duplicate Agent runtime ID: ${metadata.identity.agentId}.`);
      }
      const entry: ObserverEntry = {
        closed: false,
        degraded: false,
        factory: metadata.createRunObserver,
        identity: metadata.identity,
        outputHandled: false,
        started: false,
        terminal: false,
        validateOutput: metadata.validateOutput,
      };
      this.entries.set(metadata.identity.agentId, entry);
      this.orderedEntries.push(entry);
    }
    this.activeAgentId = getAgentRuntimeMetadata(root)?.identity.agentId;
  }

  public start(): void {
    const entry = this.activeEntry();
    if (entry !== undefined) {
      this.ensureStarted(entry);
    }
  }

  public progress(event: AgentProgressEvent): void {
    if (this.closed) {
      return;
    }
    if (event.type === "agent_updated" && event.agentId !== undefined) {
      const next = this.entries.get(event.agentId);
      if (next !== undefined) {
        this.activeAgentId = event.agentId;
        this.ensureStarted(next);
      }
    }
    const entry = this.activeEntry();
    if (entry?.observer === undefined || entry.degraded) {
      return;
    }
    try {
      entry.observer.progress(event);
    } catch (error) {
      this.degrade(entry, "progress", error);
    }
  }

  public async output(output: unknown): Promise<AgentRunValidation | undefined> {
    const entry = this.activeEntry();
    if (entry === undefined || entry.outputHandled) {
      return undefined;
    }
    entry.outputHandled = true;
    this.ensureStarted(entry);
    const observed = await entry.observer?.output(output);
    if (observed !== undefined) {
      return observed;
    }
    return entry.validateOutput?.(output);
  }

  public stop(reason: AgentStopReason): void {
    this.finish("stop", reason);
  }

  public error(cause: unknown): void {
    this.finish("error", cause);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const entry of [...this.orderedEntries].reverse()) {
      if (entry.observer === undefined || entry.closed) {
        continue;
      }
      entry.closed = true;
      try {
        await entry.observer.close();
      } catch (error) {
        this.degrade(entry, "close", error);
      }
    }
  }

  private activeEntry(): ObserverEntry | undefined {
    return this.activeAgentId === undefined ? undefined : this.entries.get(this.activeAgentId);
  }

  private ensureStarted(entry: ObserverEntry): void {
    if (entry.started || entry.degraded || entry.factory === undefined) {
      return;
    }
    entry.started = true;
    try {
      const context: AgentObservabilityContext = {
        ...entry.identity,
        atomicFlow: this.options.atomicFlow,
        parentInstanceId: this.options.parentInstanceId,
        prompt: this.options.prompt,
        runId: this.options.runId,
      };
      entry.observer = entry.factory(context);
      entry.observer.start();
    } catch (error) {
      this.degrade(entry, "start", error);
    }
  }

  private finish(operation: "error" | "stop", value: unknown): void {
    for (const entry of [...this.orderedEntries].reverse()) {
      if (entry.observer === undefined || entry.terminal) {
        continue;
      }
      entry.terminal = true;
      try {
        if (operation === "stop") {
          entry.observer.stop(value as AgentStopReason);
        } else {
          entry.observer.error(value);
        }
      } catch (error) {
        this.degrade(entry, operation, error);
      }
    }
  }

  private degrade(entry: ObserverEntry, operation: string, cause: unknown): void {
    if (entry.degraded) {
      return;
    }
    entry.degraded = true;
    try {
      this.options.atomicFlow.emit({
        atom: RUNTIME_ATOMS.observabilityDegraded,
        instance: {
          id: randomUUID(),
          parentId: this.options.parentInstanceId,
        },
        internal: true,
        payload: {
          code: "AGENT_OBSERVER_FAILED",
          summary: boundedSummary(cause instanceof Error ? cause.message : String(cause)),
          values: {
            agentId: entry.identity.agentId,
            agentType: entry.identity.agentType,
            operation,
          },
        },
        phase: "error",
      });
    } catch {
      // A failed diagnostic cannot alter the Agent run.
    }
  }
}

export function createAgentGraphRunObserver(
  root: Agent,
  options: CreateAgentGraphRunObserverOptions,
): AgentGraphRunObserver {
  return new AgentGraphRunObserver(root, options);
}
