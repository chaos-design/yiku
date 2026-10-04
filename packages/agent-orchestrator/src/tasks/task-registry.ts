import { randomUUID } from "node:crypto";
import { HookError, type HookEventBase, type HookSession, type HookTask } from "@yiku/hooks";
import type { SessionTaskRecord } from "../session/session-state.js";
import { requireText } from "../validation.js";
import { InMemoryTaskStore, type TaskStore } from "./task-store.js";

export type TaskRecord = SessionTaskRecord;

export interface CreateTaskInput {
  readonly activeForm?: string | undefined;
  readonly description?: string | undefined;
  readonly id?: string | undefined;
  readonly owner?: string | undefined;
  readonly subject: string;
}

export interface CompleteTaskInput {
  readonly expectedRevision: number;
  readonly id: string;
  readonly teammateName?: string | undefined;
}

export interface BlockTaskInput {
  readonly expectedRevision: number;
  readonly id: string;
}

export interface TaskRegistryOptions {
  readonly eventBase: HookEventBase<"TaskCreated">;
  readonly hookSession?: HookSession | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly store?: TaskStore | undefined;
}

export interface ReconcileTaskInput {
  readonly status: Extract<TaskRecord["status"], "completed" | "in_progress" | "pending">;
  readonly subject: string;
}

export class TaskRevisionConflictError extends Error {
  public override readonly name = "TaskRevisionConflictError";
}

export class TaskRegistry {
  private readonly hookSession?: HookSession | undefined;
  private readonly idGenerator: () => string;
  private readonly store: TaskStore;

  public constructor(private readonly options: TaskRegistryOptions) {
    this.hookSession = options.hookSession;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.store = options.store ?? new InMemoryTaskStore();
  }

  public async create(input: CreateTaskInput): Promise<TaskRecord> {
    const draft: HookTask = {
      ...(input.activeForm !== undefined ? { active_form: input.activeForm } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      id: input.id ?? this.idGenerator(),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      status: "pending",
      subject: requireText(input.subject, "Task subject"),
    };

    const tasks = await this.store.list();
    if (tasks.some((task) => task.id === draft.id)) {
      throw new Error(`Task already exists: ${draft.id}.`);
    }

    const decision = await this.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "TaskCreated",
      task: draft,
    });
    requireAllowed("TaskCreated", decision?.action, decision?.reasons);
    const task = applyTaskUpdate(draft, decision?.updatedInput);
    const record = Object.freeze({ ...task, revision: 1 });
    await this.store.replace([...tasks, record]);
    return record;
  }

  public async complete(input: CompleteTaskInput): Promise<TaskRecord> {
    const tasks = await this.store.list();
    const current = tasks.find((task) => task.id === input.id);
    if (current === undefined) {
      throw new Error(`Task not found: ${input.id}.`);
    }
    requireRevision(current, input.expectedRevision);

    const candidate: HookTask = {
      ...current,
      status: "completed",
    };
    const decision = await this.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "TaskCompleted",
      task: candidate,
      ...(input.teammateName !== undefined ? { teammate_name: input.teammateName } : {}),
    });
    requireAllowed("TaskCompleted", decision?.action, decision?.reasons);

    const completed = Object.freeze({
      ...current,
      revision: current.revision + 1,
      status: "completed" as const,
    });
    await this.store.replace(tasks.map((task) => (task.id === current.id ? completed : task)));
    return completed;
  }

  public async block(input: BlockTaskInput): Promise<TaskRecord> {
    const tasks = await this.store.list();
    const current = tasks.find((task) => task.id === input.id);
    if (current === undefined) {
      throw new Error(`Task not found: ${input.id}.`);
    }
    requireRevision(current, input.expectedRevision);
    const blocked = Object.freeze({
      ...current,
      revision: current.revision + 1,
      status: "blocked" as const,
    });
    await this.store.replace(tasks.map((task) => (task.id === current.id ? blocked : task)));
    return blocked;
  }

  public async get(id: string): Promise<TaskRecord | undefined> {
    return (await this.store.list()).find((task) => task.id === id);
  }

  public list(): Promise<readonly TaskRecord[]> {
    return this.store.list();
  }

  public async reconcile(inputs: readonly ReconcileTaskInput[]): Promise<readonly TaskRecord[]> {
    const current = await this.store.list();
    const bySubject = new Map(current.map((task) => [task.subject, task]));
    const next: TaskRecord[] = [];

    for (const input of inputs) {
      const subject = requireText(input.subject, "Task subject");
      const existing = bySubject.get(subject);

      if (existing === undefined) {
        const draft: HookTask = {
          id: this.idGenerator(),
          status: input.status,
          subject,
        };
        const decision = await this.dispatchCreated(draft);
        const task = applyTaskUpdate(draft, decision?.updatedInput);
        next.push(Object.freeze({ ...task, revision: 1 }));
        continue;
      }

      if (existing.status === input.status) {
        next.push(existing);
        continue;
      }

      const updated = Object.freeze({
        ...existing,
        revision: existing.revision + 1,
        status: input.status,
      });
      if (input.status === "completed" && existing.status !== "completed") {
        await this.dispatchCompleted(updated);
      }
      next.push(updated);
    }

    const subjects = new Set<string>();
    for (const task of next) {
      if (subjects.has(task.subject)) {
        throw new Error(`Duplicate task subject: ${task.subject}.`);
      }
      subjects.add(task.subject);
    }

    return this.store.replace(next);
  }

  private async dispatchCreated(draft: HookTask) {
    const decision = await this.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "TaskCreated",
      task: draft,
    });
    requireAllowed("TaskCreated", decision?.action, decision?.reasons);
    return decision;
  }

  private async dispatchCompleted(task: TaskRecord): Promise<void> {
    const decision = await this.hookSession?.dispatch({
      ...this.options.eventBase,
      hook_event_name: "TaskCompleted",
      task: {
        ...task,
        status: "completed",
      },
    });
    requireAllowed("TaskCompleted", decision?.action, decision?.reasons);
  }
}

function applyTaskUpdate(
  task: HookTask,
  update: Readonly<Record<string, unknown>> | undefined,
): HookTask {
  if (update === undefined) {
    return task;
  }

  return {
    ...task,
    ...(typeof update.active_form === "string"
      ? { active_form: requireText(update.active_form, "Task active form") }
      : {}),
    ...(typeof update.description === "string" ? { description: update.description.trim() } : {}),
    ...(typeof update.owner === "string" ? { owner: requireText(update.owner, "Task owner") } : {}),
    ...(typeof update.subject === "string"
      ? { subject: requireText(update.subject, "Task subject") }
      : {}),
  };
}

function requireAllowed(
  eventName: "TaskCompleted" | "TaskCreated",
  action: string | undefined,
  reasons: readonly string[] | undefined,
): void {
  if (action !== "block" && action !== "stop") {
    return;
  }

  throw new HookError(
    "HOOK_EXECUTION_FAILED",
    `${eventName} was blocked: ${reasons?.join("; ") || "blocked"}.`,
    { eventName },
  );
}

function requireRevision(task: TaskRecord, expectedRevision: number): void {
  if (task.revision !== expectedRevision) {
    throw new TaskRevisionConflictError(
      `Task revision conflict: expected ${expectedRevision}, received ${task.revision}.`,
    );
  }
}
