import { describe, expect, it, vi } from "vitest";
import { HookConfigCompiler } from "../src/config/compiler.js";
import { hookSource } from "../src/config/source.js";
import { buildHookTrustDescriptor, HookEngine } from "../src/engine.js";
import { HookExecutionError, HookTimeoutError } from "../src/errors.js";
import type { HookOperationEvent } from "../src/events.js";
import { HookExecutorRegistry } from "../src/executors/registry.js";
import { HookLimits } from "../src/security/limits.js";
import { HookSession } from "../src/session.js";
import { createTrustKey, type HookTrustDescriptor } from "../src/trust/canonical.js";
import { HookTrustPolicy } from "../src/trust/policy.js";
import type { HookTrustEntry, HookTrustStoreContract } from "../src/trust/types.js";
import type {
  HookExecutionResult,
  HookExecutor,
  HookHandlerOutput,
  HookInvocation,
} from "../src/types.js";

describe("HookEngine", () => {
  it("executes every matching handler and aggregates in configuration order", async () => {
    const executor = new TestExecutor("command");
    const engine = engineWithCommands(
      [
        { command: "slow-allow", type: "command" },
        { command: "fast-block", type: "command" },
        { command: "medium-context", type: "command" },
      ],
      executor,
    );
    const session = new HookSession({ engine });

    const decision = await session.dispatch(stopEvent());

    expect(executor.calls).toHaveLength(3);
    expect(decision).toMatchObject({
      action: "block",
      additionalContext: ["context from medium"],
      reasons: ["blocked by fast"],
    });
  });

  it("runs successful once handlers only once", async () => {
    const executor = new TestExecutor("command");
    const engine = engineWithCommands([{ command: "once", once: true, type: "command" }], executor);
    const session = new HookSession({ engine });

    await session.dispatch(stopEvent());
    await session.dispatch(stopEvent());

    expect(executor.calls).toHaveLength(1);
  });

  it("moves async command decisions into the background mailbox", async () => {
    const executor = new TestExecutor("command");
    const engine = engineWithCommands(
      [{ async: true, command: "async-block", once: true, type: "command" }],
      executor,
    );
    const session = new HookSession({ engine });

    await expect(session.dispatch(stopEvent())).resolves.toMatchObject({
      action: "no-op",
    });
    await sleep(30);

    expect(session.drainBackgroundDecisions()).toMatchObject({
      action: "block",
      reasons: ["background blocked"],
    });
    await session.close();
  });

  it("allows host-owned runtime callbacks without a trust policy", async () => {
    const callback = vi.fn(() => ({ additionalContext: "runtime context" }));
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("runtime"),
        value: {
          hooks: {
            SessionStart: [
              {
                hooks: [{ callback, name: "runtime", type: "callback" }],
              },
            ],
          },
        },
      },
    ]).snapshot;
    const engine = new HookEngine({
      executors: new HookExecutorRegistry([new TestExecutor("callback")]),
      snapshot,
    });

    await expect(new HookSession({ engine }).dispatch(sessionStartEvent())).resolves.toMatchObject({
      additionalContext: ["runtime context"],
    });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("fails closed for untrusted external handlers", async () => {
    const snapshot = commandSnapshot([{ command: "echo unsafe", type: "command" }]);
    const engine = new HookEngine({
      executors: new HookExecutorRegistry([new TestExecutor("command")]),
      snapshot,
    });

    await expect(new HookSession({ engine }).dispatch(stopEvent())).rejects.toMatchObject({
      code: "HOOK_TRUST_REQUIRED",
    });
  });

  it("returns no-op for supported Worktree events without matching handlers", async () => {
    const snapshot = new HookConfigCompiler().compile([]).snapshot;
    const engine = new HookEngine({ snapshot });

    await expect(new HookSession({ engine }).dispatch(worktreeEvent())).resolves.toMatchObject({
      action: "no-op",
      diagnostics: [],
    });
  });

  it("emits sanitized dispatch and execution operation events", async () => {
    const events: unknown[] = [];
    const executor = new TestExecutor("command");
    const snapshot = commandSnapshot([{ command: "once", type: "command" }]);
    const engine = new HookEngine({
      executors: new HookExecutorRegistry([executor]),
      onEvent: (event) => events.push(event),
      snapshot,
      trustPolicy: trustedPolicy(),
    });

    await new HookSession({ engine }).dispatch(stopEvent());

    expect(events).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "dispatch", phase: "start" }),
        expect.objectContaining({ operation: "execute", phase: "start" }),
        expect.objectContaining({ operation: "execute", phase: "end" }),
        expect.objectContaining({ operation: "dispatch", phase: "end" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("once");
  });

  it("covers every executor capability, parent linkage, limits, and truncation audit", async () => {
    const callback = vi.fn(() => ({}));
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("runtime"),
        value: {
          hooks: {
            Stop: [{ hooks: [{ callback, name: "runtime", type: "callback" }] }],
          },
        },
      },
      {
        source: hookSource("managed"),
        value: {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    command: "truncated",
                    shell: "/bin/bash",
                    timeout: 1,
                    type: "command",
                  },
                  {
                    allowedEnvVars: ["TOKEN"],
                    type: "http",
                    url: "https://hooks.example.test/run",
                  },
                  {
                    type: "http",
                    url: "https://hooks.example.test/no-env",
                  },
                  { prompt: "evaluate", type: "prompt" },
                  { model: "review", prompt: "review", type: "agent" },
                  { server: "policy", tool: "check", type: "mcp" },
                ],
              },
            ],
          },
        },
      },
    ]).snapshot;
    const events: HookOperationEvent[] = [];
    const engine = new HookEngine({
      executors: new HookExecutorRegistry(
        ["callback", "command", "http", "prompt", "agent", "mcp"].map(
          (type) => new TestExecutor(type as HookExecutor["type"]),
        ),
      ),
      limits: new HookLimits(),
      onEvent: (event) => events.push(event),
      snapshot,
      trustPolicy: trustedPolicy(),
    });

    await new HookSession({ engine, parentInvocationId: "parent" }).dispatch(stopEvent());

    expect(callback).toHaveBeenCalledOnce();
    expect(snapshot.hooks.map((hook) => buildHookTrustDescriptor(hook).capability)).toEqual(
      expect.arrayContaining([
        "callback:runtime",
        "command:/bin/bash:truncated:env=inherited",
        "http:https://hooks.example.test:env=TOKEN",
        "http:https://hooks.example.test:env=",
        "prompt:default",
        "agent:review",
        "mcp:policy:check",
      ]),
    );
    expect(events).toContainEqual(expect.objectContaining({ parentInvocationId: "parent" }));
    expect(events).toContainEqual(expect.objectContaining({ truncatedBytes: 5 }));
  });

  it("normalizes timeout, abort, generic, and returned executor failures", async () => {
    const executor = new TestExecutor("command");
    const session = new HookSession({
      engine: engineWithCommands(
        [
          { command: "timeout", type: "command" },
          { command: "abort", type: "command" },
          { command: "generic-error", type: "command" },
          { command: "returned-error", type: "command" },
          { command: "returned-background", type: "command" },
          { command: "stdout-only", type: "command" },
          { command: "stderr-only", type: "command" },
        ],
        executor,
      ),
    });

    await expect(session.dispatch(stopEvent())).resolves.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "HOOK_TIMEOUT" }),
        expect.objectContaining({ code: "HOOK_ABORTED" }),
        expect.objectContaining({ code: "HOOK_EXECUTION_FAILED" }),
        expect.objectContaining({ code: "HOOK_EXECUTION_ERROR" }),
        expect.objectContaining({ code: "HOOK_EXECUTION_BACKGROUND" }),
      ],
    });
  });

  it("dispatches directly without an optional parent signal", async () => {
    const engine = engineWithCommands(
      [{ command: "once", type: "command" }],
      new TestExecutor("command"),
    );

    await expect(
      engine.dispatch(stopEvent(), {
        depth: 0,
        enqueueBackground() {},
        environment: {},
        hasRunOnce: () => false,
        markOnce() {},
      }),
    ).resolves.toMatchObject({ action: "no-op" });
  });
});

class TestExecutor implements HookExecutor {
  public readonly calls: HookInvocation[] = [];

  public constructor(public readonly type: HookExecutor["type"]) {}

  public async execute(invocation: HookInvocation): Promise<HookExecutionResult> {
    this.calls.push(invocation);
    const handler = invocation.handler;
    let output: HookHandlerOutput | undefined;
    let status: HookExecutionResult["status"] = "success";
    let truncatedStderrBytes: number | undefined;
    let truncatedStdoutBytes: number | undefined;

    if (handler.type === "callback") {
      output = await handler.callback(invocation, {
        deadline: Date.now() + 1_000,
        depth: 0,
        environment: {},
      });
    } else if (handler.type === "command") {
      if (handler.command === "slow-allow") {
        await sleep(20);
        output = { action: "allow" };
      } else if (handler.command === "fast-block") {
        output = { action: "block", reason: "blocked by fast" };
      } else if (handler.command === "medium-context") {
        await sleep(10);
        output = { additionalContext: "context from medium" };
      } else if (handler.command === "async-block") {
        await sleep(20);
        output = { action: "block", reason: "background blocked" };
      } else if (handler.command === "truncated") {
        truncatedStderrBytes = 2;
        truncatedStdoutBytes = 3;
      } else if (handler.command === "timeout") {
        throw new HookTimeoutError("HOOK_TIMEOUT", "timed out");
      } else if (handler.command === "abort") {
        throw new HookExecutionError("HOOK_ABORTED", "aborted");
      } else if (handler.command === "generic-error") {
        throw new Error("generic");
      } else if (handler.command === "returned-error") {
        status = "error";
      } else if (handler.command === "returned-background") {
        status = "background";
      } else if (handler.command === "stdout-only") {
        truncatedStdoutBytes = 1;
      } else if (handler.command === "stderr-only") {
        truncatedStderrBytes = 1;
      }
    }

    const now = new Date().toISOString();
    return {
      durationMs: 0,
      endedAt: now,
      ...(output !== undefined ? { output } : {}),
      startedAt: now,
      status,
      ...(truncatedStderrBytes !== undefined ? { truncatedStderrBytes } : {}),
      ...(truncatedStdoutBytes !== undefined ? { truncatedStdoutBytes } : {}),
    };
  }
}

function engineWithCommands(
  handlers: readonly Record<string, unknown>[],
  executor: TestExecutor,
): HookEngine {
  return new HookEngine({
    executors: new HookExecutorRegistry([executor]),
    snapshot: commandSnapshot(handlers),
    trustPolicy: trustedPolicy(),
  });
}

function commandSnapshot(handlers: readonly Record<string, unknown>[]) {
  return new HookConfigCompiler().compile([
    {
      source: hookSource("project"),
      value: {
        hooks: {
          Stop: [{ hooks: handlers }],
        },
      },
    },
  ]).snapshot;
}

function trustedPolicy(): HookTrustPolicy {
  return new HookTrustPolicy({
    approvalHandler: () => ({ decision: "allow" }),
    store: new MemoryTrustStore(),
  });
}

class MemoryTrustStore implements HookTrustStoreContract {
  private readonly entries = new Map<string, HookTrustEntry>();

  public async approve(descriptor: HookTrustDescriptor): Promise<HookTrustEntry> {
    const entry = {
      approvedAt: "2026-08-01T00:00:00.000Z",
      descriptor,
      key: createTrustKey(descriptor),
    };
    this.entries.set(entry.key, entry);
    return entry;
  }

  public async has(descriptor: HookTrustDescriptor): Promise<boolean> {
    return this.entries.has(createTrustKey(descriptor));
  }

  public async list(): Promise<readonly HookTrustEntry[]> {
    return [...this.entries.values()];
  }

  public async revoke(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}

function stopEvent() {
  return {
    cwd: "/workspace",
    hook_event_name: "Stop",
    permission_mode: "default",
    session_id: "session-1",
    stop_hook_active: false,
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}

function sessionStartEvent() {
  return {
    cwd: "/workspace",
    hook_event_name: "SessionStart",
    permission_mode: "default",
    session_id: "session-1",
    source: "startup",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}

function worktreeEvent() {
  return {
    cwd: "/workspace",
    hook_event_name: "WorktreeCreate",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
