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
import { HookPermissionApproval } from "../../src/runtime/permission-hooks.js";

describe("HookPermissionApproval", () => {
  it("auto-approves ask decisions allowed by Hook policy", async () => {
    const userApproval = vi.fn();
    const approval = approvalFor(
      {
        PermissionRequest: () => ({ action: "allow", reason: "approved" }),
      },
      { userApproval },
    );

    await expect(approval.handle(permissionRequest())).resolves.toEqual({
      decision: "allow",
      reason: "approved",
    });
    expect(userApproval).not.toHaveBeenCalled();
  });

  it("denies before user approval and emits PermissionDenied", async () => {
    const denied = vi.fn(() => ({}));
    const userApproval = vi.fn();
    const approval = approvalFor(
      {
        PermissionDenied: denied,
        PermissionRequest: () => ({ action: "block", reason: "policy denied" }),
      },
      { userApproval },
    );

    await expect(approval.handle(permissionRequest())).resolves.toEqual({
      decision: "deny",
      reason: "policy denied",
    });
    expect(userApproval).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          denial_reason: "policy denied",
          tool_input: expect.objectContaining({
            capabilities: ["process.execute", "workspace.delete"],
            normalizedAction: "recursively remove workspace files",
            policyId: "recursive-force-rm",
            workspaceId: "workspace-1",
          }),
          tool_use_id: "call-1",
        }),
      }),
      expect.any(Object),
    );
  });

  it("falls through to human approval and records human denial", async () => {
    const denied = vi.fn(() => ({}));
    const userApproval = vi.fn(() => ({
      decision: "deny" as const,
      reason: "user denied",
    }));
    const approval = approvalFor(
      {
        PermissionDenied: denied,
        PermissionRequest: () => ({}),
      },
      { userApproval },
    );

    await expect(approval.handle(permissionRequest())).resolves.toEqual({
      decision: "deny",
      reason: "user denied",
    });
    expect(userApproval).toHaveBeenCalledOnce();
    expect(denied).toHaveBeenCalledOnce();
  });

  it("can require human approval even after Hook allow", async () => {
    const userApproval = vi.fn(() => ({ decision: "allow" as const }));
    const approval = approvalFor(
      {
        PermissionRequest: () => ({ action: "allow" }),
      },
      { forceHumanApproval: true, userApproval },
    );

    await expect(approval.handle(permissionRequest())).resolves.toEqual({
      decision: "allow",
    });
    expect(userApproval).toHaveBeenCalledOnce();
  });

  it("uses fallback Hook reasons and generated tool IDs", async () => {
    const denied = vi.fn(() => ({}));
    const blocked = approvalFor({
      PermissionDenied: denied,
      PermissionRequest: () => ({ action: "block" }),
    });
    const { toolCallId: _toolCallId, ...withoutCallId } = permissionRequest();

    await expect(
      blocked.handle({
        ...withoutCallId,
        metadata: { command: "rm -rf build" },
      }),
    ).resolves.toEqual({
      decision: "deny",
      reason: "Permission denied by Hook.",
    });
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          tool_input: expect.objectContaining({
            metadata: { command: "rm -rf build" },
          }),
          tool_use_id: expect.any(String),
        }),
      }),
      expect.anything(),
    );

    const allowed = approvalFor({
      PermissionRequest: () => ({ action: "allow" }),
    });
    await expect(allowed.handle(permissionRequest())).resolves.toEqual({
      decision: "allow",
      reason: "Permission approved by Hook.",
    });
  });

  it("denies when no human approval handler is configured", async () => {
    const denied = vi.fn(() => ({}));
    const approval = approvalFor({
      PermissionDenied: denied,
      PermissionRequest: () => ({}),
    });

    await expect(approval.handle(permissionRequest())).resolves.toEqual({
      decision: "deny",
      reason: "No permission approval handler configured.",
    });
    expect(denied).toHaveBeenCalledOnce();
  });
});

function approvalFor(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
  options: {
    readonly forceHumanApproval?: boolean;
    readonly userApproval?: (request: ReturnType<typeof permissionRequest>) => {
      readonly decision: "allow" | "deny";
      readonly reason?: string;
    };
  } = {},
): HookPermissionApproval {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    {
      source: hookSource("runtime"),
      value: { hooks },
    },
  ]).snapshot;
  const hookSession = new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });

  return new HookPermissionApproval({
    context: {
      cwd: "/workspace",
      hookSession,
      permissionMode: "default",
      sessionId: "session-1",
      transcriptPath: "/tmp/transcript.jsonl",
    },
    ...(options.forceHumanApproval !== undefined
      ? { forceHumanApproval: options.forceHumanApproval }
      : {}),
    ...(options.userApproval !== undefined ? { userApprovalHandler: options.userApproval } : {}),
  });
}

function permissionRequest() {
  return {
    action: "execute command",
    capabilities: ["process.execute", "workspace.delete"],
    normalizedAction: "recursively remove workspace files",
    policyId: "recursive-force-rm",
    reason: "high risk",
    risk: "high" as const,
    subject: "rm -rf build",
    toolCallId: "call-1",
    toolName: "bashTool",
    workspaceId: "workspace-1",
  };
}
