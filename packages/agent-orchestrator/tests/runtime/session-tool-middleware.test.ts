import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SessionToolCheckpointStore,
  SessionToolMiddleware,
} from "../../src/runtime/session-tool-middleware.js";
import { createInitialSessionState, type SessionState } from "../../src/session/session-state.js";
import { SessionStore } from "../../src/session/session-store.js";
import { WorkspaceSnapshotLimitError } from "../../src/workspace/workspace-snapshot-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SessionToolMiddleware", () => {
  it("checkpoints before execution and records successful completion", async () => {
    const store = await createStore("success");
    const middleware = new SessionToolMiddleware({
      sessionId: "success",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        callId: "call-1",
        effect: "read",
        execute: async (input) => {
          const current = await store.load("success");
          expect(current.inFlightOperations).toEqual([
            expect.objectContaining({
              callId: "call-1",
              effect: "read",
              toolName: "grepTool",
            }),
          ]);
          return input.value;
        },
        input: { value: "result" },
        toolName: "grepTool",
        validate: (input) => input as { value: string },
      }),
    ).resolves.toBe("result");

    await expect(store.load("success")).resolves.toMatchObject({
      budget: {
        toolCalls: 1,
      },
      inFlightOperations: [],
      lastCompletedOperation: {
        callId: "call-1",
        effect: "read",
        outputSummary: "result",
        status: "succeeded",
      },
    });
    await store.close();
  });

  it("records failure and rethrows the original error", async () => {
    const store = await createStore("failure");
    const middleware = new SessionToolMiddleware({
      sessionId: "failure",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        callId: "call-1",
        effect: "write",
        execute: async () => {
          throw new Error("edit failed");
        },
        input: { path: "file.ts" },
        toolName: "textEditorTool",
        validate: (input) => input as { path: string },
      }),
    ).rejects.toThrow("edit failed");
    await expect(store.load("failure")).resolves.toMatchObject({
      inFlightOperations: [],
      lastCompletedOperation: {
        callId: "call-1",
        status: "failed",
      },
    });
    await store.close();
  });

  it("does not execute a side effect when the start checkpoint fails", async () => {
    const execute = vi.fn(async () => "unused");
    const initial = initialState("blocked");
    const store: SessionToolCheckpointStore = {
      load: async () => initial,
      update: async () => {
        throw new Error("checkpoint unavailable");
      },
    };
    const middleware = new SessionToolMiddleware({
      sessionId: "blocked",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        callId: "call-1",
        effect: "external",
        execute,
        input: {},
        toolName: "externalTool",
        validate: (input) => input as object,
      }),
    ).rejects.toThrow("checkpoint unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("tracks concurrent calls independently by callId", async () => {
    const store = await createStore("concurrent");
    const middleware = new SessionToolMiddleware({
      sessionId: "concurrent",
      stageId: () => "stage-1",
      store,
    });
    let started = 0;
    let release: (() => void) | undefined;
    let bothStarted: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = (callId: string) =>
      middleware.run({
        callId,
        effect: "read" as const,
        execute: async () => {
          started += 1;
          if (started === 2) {
            bothStarted?.();
          }
          await releasePromise;
          return callId;
        },
        input: { callId },
        toolName: "grepTool",
        validate: (input) => input as { callId: string },
      });
    const executions = [run("call-1"), run("call-2")];

    await startedPromise;
    expect((await store.load("concurrent")).inFlightOperations.map((item) => item.callId)).toEqual([
      "call-1",
      "call-2",
    ]);
    release?.();
    await expect(Promise.all(executions)).resolves.toEqual(["call-1", "call-2"]);
    expect((await store.load("concurrent")).inFlightOperations).toEqual([]);
    await store.close();
  });

  it("generates defaults, delegates to inner middleware, and bounds summaries", async () => {
    const store = await createStore("defaults");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const inner = {
      run: vi.fn(async (request) => request.execute(request.input)),
    };
    const middleware = new SessionToolMiddleware({
      inner,
      sessionId: "defaults",
      stageId: () => "stage-default",
      store,
    });

    await expect(
      middleware.run({
        execute: async () => "x".repeat(9_000),
        input: circular,
        toolName: "externalTool",
        validate: (input) => input as object,
      }),
    ).resolves.toHaveLength(9_000);
    expect(inner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: expect.any(String),
        effect: "external",
      }),
    );
    expect((await store.load("defaults")).lastCompletedOperation).toMatchObject({
      inputSummary: "[object Object]",
      outputSummary: expect.stringContaining("[truncated]"),
    });
    await store.close();
  });

  it("aggregates tool and completion-checkpoint failures", async () => {
    let current = initialState("aggregate");
    let updates = 0;
    const store: SessionToolCheckpointStore = {
      load: async () => current,
      update: async (_sessionId, _revision, update) => {
        updates += 1;
        if (updates === 2) {
          throw new Error("completion checkpoint failed");
        }
        current = { ...update(current), revision: current.revision + 1 };
        return current;
      },
    };
    const middleware = new SessionToolMiddleware({
      sessionId: "aggregate",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        callId: "call-1",
        execute: async () => {
          throw new Error("tool failed");
        },
        input: {},
        toolName: "externalTool",
        validate: (input) => input as object,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it("gates write tools and only assessed workspace-mutating process tools", async () => {
    const store = await createStore("workspace-gate");
    const order: string[] = [];
    const checkpointService = {
      beforeTool: vi.fn(async () => {
        order.push("checkpoint");
      }),
    };
    const shouldCheckpoint = vi.fn(
      (request: { readonly effect: string; readonly input: unknown }) =>
        request.effect === "process" &&
        (request.input as { readonly capabilities?: readonly string[] }).capabilities?.includes(
          "workspace.delete",
        ) === true,
    );
    const middleware = new SessionToolMiddleware({
      checkpointService,
      sessionId: "workspace-gate",
      shouldCheckpoint,
      stageId: () => "stage-1",
      store,
    });
    const run = (effect: "process" | "read" | "write", capabilities: readonly string[] = []) =>
      middleware.run({
        effect,
        execute: async () => {
          order.push(`execute:${effect}`);
          return effect;
        },
        input: { capabilities },
        toolName: `${effect}Tool`,
        validate: (input) => input as { capabilities: readonly string[] },
      });

    await run("write");
    await run("process", ["process.execute", "workspace.delete"]);
    await run("process", ["process.execute"]);
    await run("read");

    expect(order).toEqual([
      "checkpoint",
      "execute:write",
      "checkpoint",
      "execute:process",
      "execute:process",
      "execute:read",
    ]);
    expect(checkpointService.beforeTool).toHaveBeenCalledTimes(2);
    expect(shouldCheckpoint).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it("denies execution by default when the workspace checkpoint exceeds a limit", async () => {
    const store = await createStore("limit-deny");
    const execute = vi.fn(async () => "unused");
    const middleware = new SessionToolMiddleware({
      checkpointService: {
        beforeTool: async () => {
          throw new WorkspaceSnapshotLimitError("bytes", 11, 10);
        },
      },
      sessionId: "limit-deny",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        effect: "write",
        execute,
        input: { path: "file.ts" },
        toolName: "writeTool",
        validate: (input) => input as { path: string },
      }),
    ).rejects.toThrow(/requires approval to run without a workspace checkpoint/u);
    expect(execute).not.toHaveBeenCalled();
    await store.close();
  });

  it("continues without a checkpoint when a snapshot limit is explicitly approved", async () => {
    const store = await createStore("limit-allow");
    const execute = vi.fn(async () => "written");
    const checkpointApproval = vi.fn(async () => true);
    const middleware = new SessionToolMiddleware({
      checkpointApproval,
      checkpointService: {
        beforeTool: async () => {
          throw new WorkspaceSnapshotLimitError("files", 2, 1);
        },
      },
      sessionId: "limit-allow",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        callId: "call-limit",
        effect: "write",
        execute,
        input: { path: "file.ts" },
        toolName: "writeTool",
        validate: (input) => input as { path: string },
      }),
    ).resolves.toBe("written");
    expect(checkpointApproval).toHaveBeenCalledWith({
      callId: "call-limit",
      effect: "write",
      input: { path: "file.ts" },
      toolName: "writeTool",
      validate: expect.any(Function),
      execute: expect.any(Function),
    });
    expect(execute).toHaveBeenCalledOnce();
    await store.close();
  });

  it("rejects duplicate in-flight call IDs", async () => {
    const store = await createStore("duplicate");
    let release: (() => void) | undefined;
    const middleware = new SessionToolMiddleware({
      sessionId: "duplicate",
      stageId: () => "stage-1",
      store,
    });
    const request = {
      callId: "same-call",
      effect: "read" as const,
      execute: async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        }),
      input: {},
      toolName: "readTool",
      validate: (input: unknown) => input as object,
    };
    const first = middleware.run(request);
    await vi.waitFor(async () => {
      expect((await store.load("duplicate")).inFlightOperations).toHaveLength(1);
    });

    await expect(middleware.run(request)).rejects.toThrow("already in flight");
    release?.();
    await expect(first).resolves.toBe("done");
    await store.close();
  });

  it("propagates non-limit checkpoint failures without requesting approval", async () => {
    const store = await createStore("checkpoint-error");
    const checkpointApproval = vi.fn(async () => true);
    const execute = vi.fn(async () => "unused");
    const middleware = new SessionToolMiddleware({
      checkpointApproval,
      checkpointService: {
        beforeTool: async () => {
          throw new Error("snapshot storage offline");
        },
      },
      sessionId: "checkpoint-error",
      stageId: () => "stage-1",
      store,
    });

    await expect(
      middleware.run({
        effect: "write",
        execute,
        input: {},
        toolName: "writeTool",
        validate: (input) => input as object,
      }),
    ).rejects.toThrow("snapshot storage offline");
    expect(checkpointApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await store.close();
  });
});

async function createStore(sessionId: string): Promise<SessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-tool-checkpoint-"));
  temporaryDirectories.push(directory);
  const store = new SessionStore({
    heartbeatIntervalMs: 0,
    sessionsDir: directory,
  });
  await store.create(initialState(sessionId));
  return store;
}

function initialState(sessionId: string): SessionState {
  return createInitialSessionState({
    agentKey: "code",
    configFingerprint: "config-v1",
    modelKey: "default",
    now: "2026-08-01T00:00:00.000Z",
    sessionId,
    workspaceDir: "/workspace",
  });
}
