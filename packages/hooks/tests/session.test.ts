import { describe, expect, it } from "vitest";
import { HookConfigCompiler } from "../src/config/compiler.js";
import { hookSource } from "../src/config/source.js";
import { HookEngine } from "../src/engine.js";
import { HookError } from "../src/errors.js";
import { HookExecutorRegistry } from "../src/executors/registry.js";
import { HookSession } from "../src/session.js";
import { HookTrustPolicy } from "../src/trust/policy.js";
import type {
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookInvocation,
} from "../src/types.js";

describe("HookSession", () => {
  it("limits repeatable blocking decisions", async () => {
    const engine = testEngine(new BlockingExecutor(), {
      maxStopBlocks: 1,
    });
    const session = new HookSession({ engine });

    await expect(session.dispatch(stopEvent())).resolves.toMatchObject({ action: "block" });
    await expect(session.dispatch(stopEvent())).resolves.toMatchObject({
      action: "no-op",
      diagnostics: [
        {
          code: "HOOK_BLOCK_LIMIT_REACHED",
        },
      ],
    });
  });

  it("propagates parent cancellation to executors", async () => {
    const controller = new AbortController();
    const executor = new WaitingExecutor();
    const session = new HookSession({
      engine: testEngine(executor),
      signal: controller.signal,
    });
    const dispatch = session.dispatch(stopEvent());
    controller.abort(new Error("parent canceled"));

    await expect(dispatch).resolves.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "HOOK_ABORTED",
        }),
      ],
    });
  });

  it("closes idempotently and rejects later dispatches", async () => {
    const session = new HookSession({
      engine: testEngine(new BlockingExecutor()),
    });

    await session.close();
    await session.close();

    await expect(session.dispatch(stopEvent())).rejects.toBeInstanceOf(HookError);
  });

  it("returns an empty background decision when the mailbox is empty", () => {
    const session = new HookSession({
      engine: testEngine(new BlockingExecutor()),
    });

    expect(session.drainBackgroundDecisions()).toMatchObject({
      action: "no-op",
      diagnostics: [],
    });
  });

  it("handles a pre-aborted parent and bounds background shutdown", async () => {
    const parent = new AbortController();
    parent.abort("pre-aborted");
    const preAborted = new HookSession({
      engine: testEngine(new WaitingExecutor()),
      signal: parent.signal,
    });
    await expect(preAborted.dispatch(stopEvent())).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "HOOK_ABORTED" })],
    });

    const background = new HookSession({
      engine: asyncEngine(new WaitingExecutor()),
    });
    await expect(background.dispatch(stopEvent())).resolves.toMatchObject({
      action: "no-op",
    });
    await expect(background.close()).resolves.toBeUndefined();
  });
});

class BlockingExecutor implements HookExecutor {
  public readonly type = "command";

  public async execute(): Promise<HookExecutionResult> {
    return successResult({
      action: "block",
      reason: "keep working",
    });
  }
}

class WaitingExecutor implements HookExecutor {
  public readonly type = "command";

  public execute(
    _invocation: HookInvocation,
    _handler: HookInvocation["handler"],
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(context.signal?.reason);
      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted === true) {
        onAbort();
      }
    });
  }
}

function testEngine(
  executor: HookExecutor,
  limits: ConstructorParameters<typeof HookEngine>[0]["limits"] = {},
): HookEngine {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("managed"),
      value: {
        hooks: {
          Stop: [
            {
              hooks: [{ command: "test", type: "command" }],
            },
          ],
        },
      },
    },
  ]).snapshot;

  return new HookEngine({
    executors: new HookExecutorRegistry([executor]),
    limits,
    snapshot,
    trustPolicy: new HookTrustPolicy({
      store: {
        async approve() {
          throw new Error("not used");
        },
        async has() {
          return false;
        },
        async list() {
          return [];
        },
        async revoke() {
          return false;
        },
      },
    }),
  });
}

function asyncEngine(executor: HookExecutor): HookEngine {
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("managed"),
      value: {
        hooks: {
          Stop: [
            {
              hooks: [{ async: true, command: "test", type: "command" }],
            },
          ],
        },
      },
    },
  ]).snapshot;

  return new HookEngine({
    executors: new HookExecutorRegistry([executor]),
    limits: { backgroundCloseTimeoutMs: 5 },
    snapshot,
    trustPolicy: new HookTrustPolicy({
      store: {
        async approve() {
          throw new Error("not used");
        },
        async has() {
          return false;
        },
        async list() {
          return [];
        },
        async revoke() {
          return false;
        },
      },
    }),
  });
}

function successResult(output: HookExecutionResult["output"]): HookExecutionResult {
  return {
    durationMs: 0,
    endedAt: "2026-08-01T00:00:00.000Z",
    output,
    startedAt: "2026-08-01T00:00:00.000Z",
    status: "success",
  };
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
