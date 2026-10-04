import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { YikuPaths } from "@yiku/config";
import {
  type MemoryError,
  type MemoryEventHandler,
  type MemoryExtractor,
  MemoryLifecycle,
  MemoryManager,
  type MemoryStore,
  SqliteMemoryStore,
  type WorkingMemoryStore,
} from "@yiku/memories";
import type { AgentSessionMemoryOptions } from "./types.js";

export interface MemoryRuntimeOptions {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly extraction?: boolean | undefined;
  readonly extractor?: MemoryExtractor | undefined;
  readonly failureMode?: "best-effort" | "strict" | undefined;
  readonly filePath?: string | undefined;
  readonly namespace?: string | undefined;
  readonly onError?: ((error: MemoryError) => void) | undefined;
  readonly onEvent?: MemoryEventHandler | undefined;
  readonly sessionId: string;
  readonly storeFactory?: ((filePath: string) => MemoryStore) | undefined;
  readonly workspaceDir: string;
  readonly workingStore?: WorkingMemoryStore | undefined;
}

export class MemoryRuntime {
  private readonly memoryOptions?: AgentSessionMemoryOptions | undefined;

  public constructor(options: MemoryRuntimeOptions) {
    if (!options.enabled) {
      return;
    }

    const workspaceDir = resolve(options.workspaceDir);
    const projectHash = createHash("sha256").update(workspaceDir).digest("hex");
    const projectId = `project:${projectHash.slice(0, 32)}`;
    const context = Object.freeze({
      namespace: options.namespace ?? `yiku:${projectHash}`,
      scope: Object.freeze({
        agentId: requireIdentifier(options.agentId, "Memory Agent ID"),
        projectId,
      }),
    });
    requireIdentifier(options.sessionId, "Memory Session ID");
    const filePath = resolve(
      options.filePath ?? new YikuPaths({ workspaceDir }).workspaceMemoryFilePath,
    );
    const store = options.storeFactory?.(filePath) ?? new SqliteMemoryStore({ filePath });
    const manager = new MemoryManager({
      ...(options.extractor !== undefined ? { extractor: options.extractor } : {}),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      store,
    });
    const lifecycle = new MemoryLifecycle({
      manager,
      ...(options.workingStore !== undefined ? { workingStore: options.workingStore } : {}),
    });

    this.memoryOptions = Object.freeze({
      context,
      extraction: Object.freeze({
        enabled: options.extraction === true && options.extractor !== undefined,
      }),
      failureMode: options.failureMode ?? "best-effort",
      lifecycle,
      manager,
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
  }

  public sessionOptions(): AgentSessionMemoryOptions | undefined {
    return this.memoryOptions;
  }

  public async close(): Promise<void> {
    await this.memoryOptions?.manager.close();
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
