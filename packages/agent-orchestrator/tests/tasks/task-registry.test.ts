import {
  CallbackHookExecutor,
  type HookCallback,
  HookConfigCompiler,
  HookEngine,
  type HookEventName,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { TaskRegistry, TaskRevisionConflictError } from "../../src/tasks/task-registry.js";

describe("TaskRegistry", () => {
  it("applies TaskCreated modifications before persistence", async () => {
    const registry = taskRegistry({
      TaskCreated: () => ({
        updatedInput: {
          owner: "worker-1",
          subject: "Reviewed subject",
        },
      }),
    });

    await expect(registry.create({ id: "task-1", subject: "Original" })).resolves.toEqual({
      id: "task-1",
      owner: "worker-1",
      revision: 1,
      status: "pending",
      subject: "Reviewed subject",
    });
  });

  it("blocks completion before writing terminal state", async () => {
    const registry = taskRegistry({
      TaskCompleted: () => ({ action: "block", reason: "tests missing" }),
    });
    const task = await registry.create({ id: "task-1", subject: "Review" });

    await expect(
      registry.complete({ expectedRevision: task.revision, id: task.id }),
    ).rejects.toThrow("tests missing");
    expect((await registry.get(task.id))?.status).toBe("pending");
  });

  it("completes tasks with optimistic revision checks", async () => {
    const registry = taskRegistry({});
    const task = await registry.create({ id: "task-1", subject: "Review" });

    await expect(registry.complete({ expectedRevision: 0, id: task.id })).rejects.toBeInstanceOf(
      TaskRevisionConflictError,
    );
    await expect(registry.complete({ expectedRevision: 1, id: task.id })).resolves.toMatchObject({
      revision: 2,
      status: "completed",
    });
    expect(await registry.list()).toHaveLength(1);
  });

  it("supports generated IDs, optional fields, duplicate checks, and missing tasks", async () => {
    const registry = new TaskRegistry({
      eventBase: eventBase(),
      idGenerator: () => "generated",
    });
    await expect(
      registry.create({
        activeForm: "Reviewing",
        description: " details ",
        owner: "worker",
        subject: " Generated ",
      }),
    ).resolves.toMatchObject({
      active_form: "Reviewing",
      description: " details ",
      id: "generated",
      owner: "worker",
      subject: "Generated",
    });
    await expect(registry.create({ id: "generated", subject: "Duplicate" })).rejects.toThrow(
      "already exists",
    );
    await expect(registry.create({ subject: " " })).rejects.toThrow("must be non-empty");
    await expect(registry.complete({ expectedRevision: 1, id: "missing" })).rejects.toThrow(
      "not found",
    );
  });

  it("passes teammate metadata and validates every mutable task field", async () => {
    const completed = vi.fn(() => ({}));
    const registry = taskRegistry({ TaskCompleted: completed });
    const task = await registry.create({ id: "task-1", subject: "Review" });

    await registry.complete({
      expectedRevision: task.revision,
      id: task.id,
      teammateName: "worker-1",
    });
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ teammate_name: "worker-1" }),
      }),
      expect.anything(),
    );

    for (const updatedInput of [{ active_form: " " }, { owner: " " }, { subject: " " }]) {
      const invalid = taskRegistry({
        TaskCreated: () => ({ updatedInput }),
      });
      await expect(invalid.create({ subject: "Valid" })).rejects.toThrow("must be non-empty");
    }
    const description = taskRegistry({
      TaskCreated: () => ({ updatedInput: { description: " trimmed " } }),
    });
    await expect(description.create({ subject: "Valid" })).resolves.toMatchObject({
      description: "trimmed",
    });
  });

  it("uses a fallback reason for blocking task decisions", async () => {
    const registry = taskRegistry({
      TaskCreated: () => ({ action: "block" }),
    });
    await expect(registry.create({ subject: "Stopped" })).rejects.toThrow(
      "TaskCreated was blocked: blocked",
    );
  });
});

function taskRegistry(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
): TaskRegistry {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    { source: hookSource("runtime"), value: { hooks } },
  ]).snapshot;
  const hookSession = new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });

  return new TaskRegistry({
    eventBase: {
      cwd: "/workspace",
      hook_event_name: "TaskCreated",
      permission_mode: "default",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
    },
    hookSession,
  });
}

function eventBase() {
  return {
    cwd: "/workspace",
    hook_event_name: "TaskCreated",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
