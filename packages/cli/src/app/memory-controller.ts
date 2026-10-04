import type { AgentSessionMemoryOptions } from "@yiku/agent-orchestrator";
import type { AtomicFlowRun } from "@yiku/atomic-flow";
import type {
  ConsolidateMemoriesResult,
  ForgetUnifiedMemoryResult,
  MemoryLifecycleStatus,
  MemorySearchClass,
  MemorySearchResult,
} from "@yiku/memories";

export interface SearchMemoryOptions {
  readonly classes?: readonly MemorySearchClass[] | undefined;
  readonly limit?: number | undefined;
  readonly maxChars?: number | undefined;
}

export class MemoryController {
  public constructor(
    private readonly options: {
      readonly memories: AgentSessionMemoryOptions;
      readonly createFlow?: ((prompt: string) => AtomicFlowRun) | undefined;
      readonly sessionId: string;
    },
  ) {
    if (options.memories.lifecycle === undefined) {
      throw new Error("Memory Lifecycle is unavailable.");
    }
  }

  public status(): Promise<MemoryLifecycleStatus> {
    return this.lifecycle().status(this.options.sessionId, this.options.memories.context);
  }

  public search(
    query: string,
    options: SearchMemoryOptions = {},
  ): Promise<readonly MemorySearchResult[]> {
    return this.run(`/memory search ${query}`, (atomicFlow) =>
      this.lifecycle().search({
        ...(atomicFlow !== undefined ? { atomicFlow } : {}),
        ...(options.classes !== undefined ? { classes: options.classes } : {}),
        context: this.options.memories.context,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        query,
        sessionId: this.options.sessionId,
      }),
    );
  }

  public consolidate(): Promise<ConsolidateMemoriesResult> {
    return this.run("/memory consolidate", (atomicFlow) =>
      this.lifecycle().consolidate({
        ...(atomicFlow !== undefined ? { atomicFlow } : {}),
        context: this.options.memories.context,
        sessionId: this.options.sessionId,
      }),
    );
  }

  public forget(id: string, hard = false): Promise<ForgetUnifiedMemoryResult> {
    return this.run(`/memory forget ${id}`, (atomicFlow) =>
      this.lifecycle().forget({
        ...(atomicFlow !== undefined ? { atomicFlow } : {}),
        context: this.options.memories.context,
        id,
        mode: hard ? "hard" : "soft",
        sessionId: this.options.sessionId,
      }),
    );
  }

  private lifecycle() {
    const lifecycle = this.options.memories.lifecycle;
    if (lifecycle === undefined) {
      throw new Error("Memory Lifecycle is unavailable.");
    }
    return lifecycle;
  }

  private async run<T>(
    prompt: string,
    operation: (flow?: AtomicFlowRun) => Promise<T>,
  ): Promise<T> {
    const flow = this.options.createFlow?.(prompt);
    try {
      return await operation(flow);
    } finally {
      await flow?.close();
    }
  }
}
