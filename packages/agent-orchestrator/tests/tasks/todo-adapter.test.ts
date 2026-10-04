import { describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../../src/tasks/task-registry.js";
import { InMemoryTaskStore } from "../../src/tasks/task-store.js";
import { TodoAdapter } from "../../src/tasks/todo-adapter.js";

describe("TodoAdapter", () => {
  it("atomically reconciles TODO items and preserves task identity", async () => {
    let nextId = 0;
    const store = new InMemoryTaskStore();
    const registry = new TaskRegistry({
      eventBase: eventBase(),
      idGenerator: () => {
        nextId += 1;
        return `task-${nextId}`;
      },
      store,
    });
    const todo = new TodoAdapter({ registry });

    await expect(
      todo.write({
        items: [
          { content: "Inspect", status: "completed" },
          { content: "Run tests", status: "in_progress" },
        ],
      }),
    ).resolves.toBe("1. [x] Inspect\n2. [-] Run tests");
    const first = await registry.list();

    await todo.write({
      items: [
        { content: "Inspect", status: "completed" },
        { content: "Run tests", status: "completed" },
        { content: "Write docs", status: "pending" },
      ],
    });
    const second = await registry.list();

    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[1]).toMatchObject({
      id: first[1]?.id,
      revision: (first[1]?.revision ?? 0) + 1,
      status: "completed",
    });
    expect(second[2]).toMatchObject({
      id: "task-3",
      status: "pending",
      subject: "Write docs",
    });
  });

  it("rejects invalid lists without changing persisted tasks", async () => {
    const store = new InMemoryTaskStore();
    const registry = new TaskRegistry({
      eventBase: eventBase(),
      store,
    });
    const todo = new TodoAdapter({ registry });
    await todo.write({
      items: [{ content: "Existing", status: "pending" }],
    });

    await expect(
      todo.write({
        items: [
          { content: "One", status: "in_progress" },
          { content: "Two", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("Only one TODO item can be in_progress");
    await expect(
      todo.write({
        items: [{ content: " ", status: "pending" }],
      }),
    ).rejects.toThrow("TODO content is required");
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        status: "pending",
        subject: "Existing",
      }),
    ]);
  });

  it("formats empty and blocked TODO states", async () => {
    const registry = new TaskRegistry({
      eventBase: eventBase(),
      store: new InMemoryTaskStore(),
    });
    const todo = new TodoAdapter({ registry });

    await expect(todo.write({ items: [] })).resolves.toBe("TODO list is empty.");
    vi.spyOn(registry, "reconcile").mockResolvedValue([
      {
        id: "blocked",
        revision: 1,
        status: "blocked",
        subject: "Blocked task",
      },
    ]);
    await expect(
      todo.write({
        items: [{ content: "Blocked task", status: "pending" }],
      }),
    ).resolves.toBe("1. [!] Blocked task");
  });
});

function eventBase() {
  return {
    cwd: "/workspace",
    hook_event_name: "TaskCreated",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
