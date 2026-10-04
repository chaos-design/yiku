import type { WorkingMemoryRecord, WorkingMemoryStore } from "@yiku/memories";
import {
  type SessionToolCheckpointStore,
  updateCurrentSessionState,
} from "../runtime/session-tool-middleware.js";
import type { SessionState } from "./session-state.js";

export interface SessionWorkingMemoryStoreOptions {
  readonly sessionId: string;
  readonly store: SessionToolCheckpointStore;
}

export class SessionWorkingMemoryStore implements WorkingMemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: SessionWorkingMemoryStoreOptions) {}

  public async list(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
    this.requireSession(sessionId);
    return (await this.options.store.load(sessionId)).workingMemories;
  }

  public replace(
    sessionId: string,
    records: readonly WorkingMemoryRecord[],
  ): Promise<readonly WorkingMemoryRecord[]> {
    this.requireSession(sessionId);
    const next = records.map((record) => ({ ...record }));
    const operation = async () => {
      const updated = await updateCurrentSessionState(this.options.store, sessionId, (current) => ({
        ...current,
        workingMemories: next as SessionState["workingMemories"],
      }));
      return updated.workingMemories;
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private requireSession(sessionId: string): void {
    if (sessionId !== this.options.sessionId) {
      throw new Error("Working Memory Store cannot access another Session.");
    }
  }
}
