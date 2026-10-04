import { describe, expect, it, vi } from "vitest";
import { AgentMessageBus } from "../../src/messages/message-bus.js";
import type { AgentMessageEnvelope } from "../../src/messages/types.js";
import { TaskRegistry } from "../../src/tasks/task-registry.js";
import { InMemoryTaskStore } from "../../src/tasks/task-store.js";
import { WorkspaceWriteLock } from "../../src/tasks/write-lock.js";
import { delegateTaskTool } from "../../src/tools/delegate-tool.js";

describe("delegateTaskTool", () => {
  it("creates, assigns, runs, and completes a delegated task", async () => {
    const registry = taskRegistry();
    const run = vi.fn(async () => ({ output: "review complete" }));
    const events: string[] = [];
    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      onEvent: (event) => events.push(event.type),
      run,
      taskRegistry: registry,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-only",
          agent_key: "reviewer",
          prompt: "Review the code",
        }),
      ),
    ).resolves.toEqual({
      changedFiles: [],
      output: "review complete",
      taskId: "task-1",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        accessMode: "read-only",
        agentKey: "reviewer",
        prompt: "Review the code",
      }),
    );
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        owner: "reviewer",
        status: "completed",
        subject: "Review the code",
      }),
    ]);
    expect(events).toEqual(["subagent_spawned", "subagent_output", "subagent_result"]);
  });

  it("publishes native child lifecycle with the delegate call correlation", async () => {
    const messages: AgentMessageEnvelope[] = [];
    const legacyEvents: string[] = [];
    const messageBus = new AgentMessageBus({
      sinks: [
        {
          kind: "required",
          publish: (message) => {
            messages.push(message);
          },
        },
      ],
    });
    const run = vi.fn(async () => ({ output: "review complete" }));
    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      idGenerator: () => "child-1",
      messageBus,
      onEvent: (event) => legacyEvents.push(event.type),
      parentAgentId: "root",
      run,
      taskRegistry: taskRegistry(),
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-only",
          agent_key: "reviewer",
          prompt: "Review the code",
        }),
        {
          toolCall: { callId: "delegate-1" } as never,
        },
      ),
    ).resolves.toMatchObject({
      output: "review complete",
      taskId: "task-1",
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "child-1",
        parentToolCallId: "delegate-1",
        taskId: "task-1",
      }),
    );
    expect(messages).toEqual([
      expect.objectContaining({
        agentId: "child-1",
        agentSessionId: "session-1.agent.child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: expect.objectContaining({
          agentName: "reviewer",
          agentType: "reviewer",
          kind: "agent_spawned",
          profileId: "reviewer",
        }),
        sessionId: "session-1",
        taskId: "task-1",
      }),
      expect.objectContaining({
        agentId: "child-1",
        agentSessionId: "session-1.agent.child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: {
          agentName: "reviewer",
          kind: "agent_output",
          profileId: "reviewer",
          text: "review complete",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
      expect.objectContaining({
        agentId: "child-1",
        agentSessionId: "session-1.agent.child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: {
          agentName: "reviewer",
          kind: "agent_finished",
          profileId: "reviewer",
          status: "succeeded",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ]);
    expect(legacyEvents).toEqual(["subagent_spawned", "subagent_output", "subagent_result"]);
  });

  it("rejects undeclared delegates and blocks failed tasks", async () => {
    const registry = taskRegistry();
    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      run: async ({ agentKey }) => {
        if (agentKey === "reviewer") {
          throw new Error("review failed");
        }
        return { output: "unused" };
      },
      taskRegistry: registry,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          agent_key: "missing",
          prompt: "Unknown",
        }),
      ),
    ).resolves.toContain("Error: Delegate Agent is not allowed: missing");
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          agent_key: "reviewer",
          prompt: "Review failure",
        }),
      ),
    ).resolves.toContain("Error: review failed");
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        status: "blocked",
        subject: "Review failure",
      }),
    ]);
  });

  it("bounds concurrent read-only delegates", async () => {
    const registry = taskRegistry();
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      maxParallelReaders: 1,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blocked;
        active -= 1;
        return { output: "done" };
      },
      taskRegistry: registry,
    });
    const invoke = (prompt: string) =>
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-only",
          agent_key: "reviewer",
          prompt,
        }),
      );
    const runs = [invoke("First"), invoke("Second")];

    await vi.waitFor(() => expect(peak).toBe(1));
    release?.();
    await Promise.all(runs);
    expect(peak).toBe(1);
  });

  it("runs an existing write task with custom IDs, transcript paths, and middleware", async () => {
    const registry = taskRegistry();
    const task = await registry.create({ subject: "Existing task" });
    const middleware = {
      run: vi.fn((request) => request.execute(request.input)),
    };
    const run = vi.fn(async () => ({
      changedFiles: ["src/file.ts"],
      output: "written",
      patch: "diff",
    }));
    const transcriptPath = vi.fn(() => "/tmp/custom.jsonl");
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      idGenerator: () => "agent-custom",
      middleware,
      run,
      taskRegistry: registry,
      transcriptPath,
      writeLock: new WorkspaceWriteLock(),
    });
    const signal = new AbortController().signal;

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          prompt: "Write changes",
          task_id: task.id,
        }),
        {
          signal,
          toolCall: { callId: "call-1" } as never,
        },
      ),
    ).resolves.toEqual({
      changedFiles: ["src/file.ts"],
      output: "written",
      patch: "diff",
      taskId: task.id,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        accessMode: "read-write",
        agentId: "agent-custom",
        signal,
        taskId: task.id,
      }),
    );
    expect(transcriptPath).toHaveBeenCalledWith("agent-custom");
    expect(middleware.run).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        effect: "write",
      }),
    );
  });

  it("rejects invalid reader concurrency and missing task IDs", async () => {
    expect(() =>
      delegateTaskTool({
        allowedAgentKeys: [],
        eventBase: eventBase(),
        maxParallelReaders: 0,
        run: async () => ({ output: "unused" }),
        taskRegistry: taskRegistry(),
      }),
    ).toThrow("positive integer");

    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      run: async () => ({ output: "unused" }),
      taskRegistry: taskRegistry(),
    });
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          agent_key: "reviewer",
          prompt: "Missing",
          task_id: "missing",
        }),
      ),
    ).resolves.toContain("Task not found");
  });

  it("isolates write Delegates in a Worktree and returns collected changes", async () => {
    const registry = taskRegistry();
    const handle = {
      baseRevision: "abc123",
      id: "worktree-1",
      path: "/worktrees/worktree-1",
      taskId: "task-1",
    };
    const worktreeManager = {
      collectChanges: vi.fn(async () => ({
        changedFiles: ["src/file.ts"],
        patch: "diff --git a/src/file.ts b/src/file.ts",
      })),
      create: vi.fn(async () => handle),
      remove: vi.fn(async () => undefined),
    };
    const run = vi.fn(async () => ({ output: "implemented" }));
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      name: "customDelegateTool",
      run,
      taskRegistry: registry,
      worktreeManager,
    });
    expect(tool.name).toBe("customDelegateTool");

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          prompt: "Implement change",
        }),
      ),
    ).resolves.toEqual({
      changedFiles: ["src/file.ts"],
      output: "implemented",
      patch: "diff --git a/src/file.ts b/src/file.ts",
      taskId: "task-1",
      worktreeId: "worktree-1",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "worktree",
        workspaceDir: handle.path,
      }),
    );
    expect(worktreeManager.remove).toHaveBeenCalledWith(handle, {
      force: true,
    });
  });

  it("falls back only for automatic Worktree isolation", async () => {
    const unavailable = Object.assign(new Error("no HEAD"), {
      code: "GIT_WORKTREE_UNAVAILABLE",
    });
    const worktreeManager = {
      collectChanges: vi.fn(),
      create: vi.fn(async () => Promise.reject(unavailable)),
      remove: vi.fn(),
    };
    const run = vi.fn(async () => ({ output: "shared" }));
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      run,
      taskRegistry: taskRegistry(),
      worktreeManager,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          prompt: "Automatic",
        }),
      ),
    ).resolves.toMatchObject({
      output: "shared",
    });
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isolation: "shared",
        workspaceDir: "/workspace",
      }),
    );

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          isolation: "worktree",
          prompt: "Required",
        }),
      ),
    ).resolves.toContain("Error: no HEAD");
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects invalid isolation and read-only change reports", async () => {
    const registry = taskRegistry();
    const run = vi.fn(async () => ({
      changedFiles: ["unexpected.txt"],
      output: "changed",
    }));
    const tool = delegateTaskTool({
      allowedAgentKeys: ["reviewer"],
      eventBase: eventBase(),
      run,
      taskRegistry: registry,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-only",
          agent_key: "reviewer",
          isolation: "worktree",
          prompt: "Invalid isolation",
        }),
      ),
    ).resolves.toContain("Read-only Delegates cannot request Worktree");
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-only",
          agent_key: "reviewer",
          prompt: "Unexpected changes",
        }),
      ),
    ).resolves.toContain("Read-only Delegate reported workspace changes");
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "reviewer",
          isolation: "worktree",
          prompt: "Missing manager",
        }),
      ),
    ).resolves.toContain("Worktree isolation is not configured");
    expect((await registry.list()).map((task) => task.status)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
  });

  it("retains a completed Worktree when its remove Hook blocks", async () => {
    const hookBlock = Object.assign(new Error("retain"), {
      code: "WORKTREE_HOOK_BLOCKED",
    });
    const handle = {
      baseRevision: "abc123",
      id: "retained",
      path: "/worktrees/retained",
      taskId: "task-1",
    };
    const worktreeManager = {
      collectChanges: vi.fn(async () => ({ changedFiles: [], patch: "" })),
      create: vi.fn(async () => handle),
      remove: vi.fn(async () => Promise.reject(hookBlock)),
    };
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      run: async () => ({ output: "done" }),
      taskRegistry: taskRegistry(),
      worktreeManager,
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          prompt: "Retain",
        }),
      ),
    ).resolves.toMatchObject({
      output: "done",
      worktreeId: "retained",
    });
    expect(worktreeManager.remove).toHaveBeenCalledOnce();
  });

  it("fails and blocks the task when Worktree cleanup fails unexpectedly", async () => {
    const registry = taskRegistry();
    const handle = {
      baseRevision: "abc123",
      id: "cleanup-failure",
      path: "/worktrees/cleanup-failure",
      taskId: "task-1",
    };
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      run: async () => ({ output: "done" }),
      taskRegistry: registry,
      worktreeManager: {
        collectChanges: async () => ({ changedFiles: [], patch: "" }),
        create: async () => handle,
        remove: async () => Promise.reject(new Error("cleanup failed")),
      },
    });
    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          prompt: "Cleanup",
        }),
      ),
    ).resolves.toContain("Error: cleanup failed");
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        status: "blocked",
      }),
    ]);
  });

  it("honors explicit shared isolation and validates isolation input", async () => {
    const create = vi.fn(async () => Promise.reject(new Error("must not run")));
    const run = vi.fn(async () => ({ output: "shared write" }));
    const tool = delegateTaskTool({
      allowedAgentKeys: ["writer"],
      eventBase: eventBase(),
      run,
      taskRegistry: taskRegistry(),
      worktreeManager: {
        collectChanges: vi.fn(),
        create,
        remove: vi.fn(),
      },
    });

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          access_mode: "read-write",
          agent_key: "writer",
          isolation: "shared",
          prompt: "Shared",
        }),
      ),
    ).resolves.toMatchObject({
      output: "shared write",
    });
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "shared",
      }),
    );

    await expect(
      tool.invoke(
        {} as never,
        JSON.stringify({
          agent_key: "writer",
          isolation: "invalid",
          prompt: "Invalid",
        }),
      ),
    ).resolves.toContain("Error:");
  });
});

function taskRegistry(): TaskRegistry {
  let id = 0;
  return new TaskRegistry({
    eventBase: taskEventBase(),
    idGenerator: () => {
      id += 1;
      return `task-${id}`;
    },
    store: new InMemoryTaskStore(),
  });
}

function taskEventBase() {
  return {
    ...eventBase(),
    hook_event_name: "TaskCreated",
  } as const;
}

function eventBase() {
  return {
    cwd: "/workspace",
    hook_event_name: "SubagentStart",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
