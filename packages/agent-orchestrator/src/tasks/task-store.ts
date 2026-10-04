import {
  type SessionToolCheckpointStore,
  updateCurrentSessionState,
} from "../runtime/session-tool-middleware.js";
import type { SessionTaskRecord } from "../session/session-state.js";

export interface TaskStore {
  list(): Promise<readonly SessionTaskRecord[]>;
  replace(tasks: readonly SessionTaskRecord[]): Promise<readonly SessionTaskRecord[]>;
}

export interface SessionTaskStoreOptions {
  readonly sessionId: string;
  readonly store: SessionToolCheckpointStore;
}

export class InMemoryTaskStore implements TaskStore {
  private tasks: readonly SessionTaskRecord[] = Object.freeze([]);

  public async list(): Promise<readonly SessionTaskRecord[]> {
    return this.tasks;
  }

  public async replace(tasks: readonly SessionTaskRecord[]): Promise<readonly SessionTaskRecord[]> {
    this.tasks = freezeTasks(tasks);
    return this.tasks;
  }
}

export class SessionTaskStore implements TaskStore {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: SessionTaskStoreOptions) {}

  public async list(): Promise<readonly SessionTaskRecord[]> {
    return (await this.options.store.load(this.options.sessionId)).tasks;
  }

  public replace(tasks: readonly SessionTaskRecord[]): Promise<readonly SessionTaskRecord[]> {
    const nextTasks = freezeTasks(tasks);
    const operation = async () => {
      const updated = await updateCurrentSessionState(
        this.options.store,
        this.options.sessionId,
        (current) => ({
          ...current,
          budget: {
            ...current.budget,
            progressRevision:
              JSON.stringify(current.tasks) !== JSON.stringify(nextTasks)
                ? current.budget.progressRevision + 1
                : current.budget.progressRevision,
          },
          tasks: [...nextTasks],
        }),
      );
      return updated.tasks;
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function freezeTasks(tasks: readonly SessionTaskRecord[]): readonly SessionTaskRecord[] {
  return Object.freeze(
    tasks.map((task) =>
      Object.freeze({
        ...task,
      }),
    ),
  );
}
