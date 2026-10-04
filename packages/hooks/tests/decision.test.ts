import { describe, expect, it } from "vitest";
import type { CompiledHook } from "../src/config/types.js";
import { type HookDecisionInput, HookDecisionPolicy } from "../src/decision.js";
import { HookDecisionConflictError } from "../src/errors.js";
import { HookMatcher } from "../src/matching/matcher.js";
import type { HookExecutionResult, HookHandlerOutput } from "../src/types.js";

describe("HookDecisionPolicy", () => {
  it("uses the strongest action and stable deduplicated context", () => {
    const decision = new HookDecisionPolicy().aggregate([
      decisionInput("hook-1", {
        action: "allow",
        additionalContext: ["first", "shared"],
        systemMessage: "notice",
      }),
      decisionInput("hook-2", {
        action: "defer",
        additionalContext: ["shared", "second"],
      }),
      decisionInput("hook-3", {
        decision: "block",
        reason: "blocked",
      }),
      decisionInput("hook-4", {
        continue: false,
        stopReason: "stop now",
      }),
    ]);

    expect(decision).toMatchObject({
      action: "stop",
      additionalContext: ["first", "shared", "second"],
      reasons: ["blocked", "stop now"],
      systemMessages: ["notice"],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.additionalContext)).toBe(true);
  });

  it("merges disjoint and equal input updates", () => {
    const decision = new HookDecisionPolicy().aggregate([
      decisionInput("hook-1", { updatedInput: { command: "pnpm test" } }),
      decisionInput("hook-2", { updatedInput: { cwd: "/workspace" } }),
      decisionInput("hook-3", { updatedInput: { command: "pnpm test" } }),
    ]);

    expect(decision.updatedInput).toEqual({
      command: "pnpm test",
      cwd: "/workspace",
    });
  });

  it("rejects conflicting input updates deterministically", () => {
    expect(() =>
      new HookDecisionPolicy().aggregate([
        decisionInput("hook-1", { updatedInput: { command: "pnpm test" } }),
        decisionInput("hook-2", { updatedInput: { command: "rm -rf build" } }),
      ]),
    ).toThrow(HookDecisionConflictError);
  });

  it("normalizes permission decisions and suppression", () => {
    const decision = new HookDecisionPolicy().aggregate([
      decisionInput("hook-1", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
        permissionUpdates: [{ decision: "ask", rule: "Bash(git *)" }],
        suppressOutput: true,
      }),
    ]);

    expect(decision).toMatchObject({
      action: "allow",
      permissionUpdates: [{ decision: "ask", rule: "Bash(git *)" }, { decision: "allow" }],
      suppressOutput: true,
    });
  });

  it("turns failed executions into diagnostics without changing action", () => {
    const decision = new HookDecisionPolicy().aggregate([
      {
        hook: compiledHook("hook-1"),
        result: executionResult(undefined, "timeout", "HOOK_TIMEOUT"),
      },
    ]);

    expect(decision).toMatchObject({
      action: "no-op",
      diagnostics: [
        {
          code: "HOOK_TIMEOUT",
          hookId: "hook-1",
          severity: "error",
        },
      ],
    });
  });
});

function decisionInput(hookId: string, output: HookHandlerOutput): HookDecisionInput {
  return {
    hook: compiledHook(hookId),
    result: executionResult(output),
  };
}

function compiledHook(hookId: string): CompiledHook {
  return {
    eventName: "PreToolUse",
    handler: {
      command: "node hook.mjs",
      type: "command",
    },
    hookId,
    jsonPointer: `/hooks/PreToolUse/${hookId}`,
    matcher: new HookMatcher(),
    source: {
      priority: 500,
      type: "project",
    },
  };
}

function executionResult(
  output?: HookHandlerOutput,
  status: HookExecutionResult["status"] = "success",
  errorCode?: string,
): HookExecutionResult {
  return {
    durationMs: 1,
    endedAt: "2026-08-01T00:00:00.001Z",
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(output !== undefined ? { output } : {}),
    startedAt: "2026-08-01T00:00:00.000Z",
    status,
  };
}
