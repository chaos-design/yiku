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
import { McpElicitationBridge } from "../../src/mcp/elicitation.js";

describe("McpElicitationBridge", () => {
  it("accepts a Hook-provided answer without asking the user", async () => {
    const userHandler = vi.fn();
    const bridge = bridgeFor(
      {
        Elicitation: () => ({
          hookSpecificOutput: {
            hookEventName: "Elicitation",
            updatedValue: { value: "hook answer" },
          },
        }),
      },
      userHandler,
    );

    await expect(bridge.request(request())).resolves.toEqual({
      action: "accept",
      result: { value: "hook answer" },
    });
    expect(userHandler).not.toHaveBeenCalled();
  });

  it("uses the user handler and allows result modification", async () => {
    const bridge = bridgeFor(
      {
        ElicitationResult: () => ({
          hookSpecificOutput: {
            hookEventName: "ElicitationResult",
            updatedValue: { value: "sanitized" },
          },
        }),
      },
      vi.fn(async () => ({ action: "accept" as const, result: { value: "raw" } })),
    );

    await expect(bridge.request(request())).resolves.toEqual({
      action: "accept",
      result: { value: "sanitized" },
    });
  });

  it("maps request blocking to decline and result blocking to cancel", async () => {
    await expect(
      bridgeFor({
        Elicitation: () => ({ action: "block" }),
      }).request(request()),
    ).resolves.toEqual({ action: "decline" });

    await expect(
      bridgeFor({
        ElicitationResult: () => ({ action: "block" }),
      }).request(request()),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("declines without a user handler and preserves cancel responses", async () => {
    await expect(bridgeFor({}).request(request())).resolves.toEqual({
      action: "decline",
    });
    await expect(
      bridgeFor(
        {},
        vi.fn(async () => ({
          action: "cancel" as const,
        })),
      ).request(request()),
    ).resolves.toEqual({
      action: "cancel",
    });
  });

  it("forwards URL mode without a requested form Schema", async () => {
    const requestHook = vi.fn(() => ({}));
    const bridge = bridgeFor(
      {
        Elicitation: requestHook,
      },
      vi.fn(async () => ({ action: "decline" as const })),
    );

    await expect(
      bridge.request({
        message: "Authorize",
        mode: "url",
        requestId: "request-url",
        server: "remote",
        url: "https://example.test/authorize",
      }),
    ).resolves.toEqual({ action: "decline" });
    expect(requestHook).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          mode: "url",
          request_id: "request-url",
        }),
      }),
      expect.any(Object),
    );
  });
});

function bridgeFor(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
  userHandler?: (request: ReturnType<typeof request>) => Promise<{
    readonly action: "accept" | "cancel" | "decline";
    readonly result?: { readonly value: string };
  }>,
): McpElicitationBridge {
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

  return new McpElicitationBridge({
    eventBase: {
      cwd: "/workspace",
      hook_event_name: "Elicitation",
      permission_mode: "default",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
    },
    hookSession,
    ...(userHandler !== undefined ? { userHandler } : {}),
  });
}

function request() {
  return {
    message: "Choose",
    requestId: "request-1",
    server: "forms",
  };
}
