import { describe, expect, it } from "vitest";
import {
  asHookError,
  HookCapabilityError,
  HookConfigError,
  HookDecisionConflictError,
  HookError,
  HookExecutionError,
  HookMatcherError,
  HookProtocolError,
  HookSecurityError,
  HookTimeoutError,
  HookTrustError,
} from "../src/errors.js";

describe("hook errors", () => {
  it("preserves stable names and codes", () => {
    const errors = [
      new HookConfigError("HOOK_CONFIG_INVALID", "config"),
      new HookTrustError("HOOK_TRUST_REQUIRED", "trust"),
      new HookMatcherError("HOOK_MATCHER_INVALID", "matcher"),
      new HookExecutionError("HOOK_EXECUTION_FAILED", "execution"),
      new HookTimeoutError("HOOK_TIMEOUT", "timeout"),
      new HookProtocolError("HOOK_PROTOCOL_INVALID", "protocol"),
      new HookDecisionConflictError("HOOK_DECISION_CONFLICT", "decision"),
      new HookCapabilityError("HOOK_CAPABILITY_UNAVAILABLE", "capability"),
      new HookSecurityError("HOOK_SECURITY_REJECTED", "security"),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      "HookConfigError",
      "HookTrustError",
      "HookMatcherError",
      "HookExecutionError",
      "HookTimeoutError",
      "HookProtocolError",
      "HookDecisionConflictError",
      "HookCapabilityError",
      "HookSecurityError",
    ]);
    expect(errors.every((error) => error instanceof HookError)).toBe(true);
  });

  it("serializes only stable sanitized context", () => {
    const cause = new Error("secret raw provider payload");
    const error = new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook execution failed.", {
      cause,
      eventName: "PreToolUse",
      executorType: "command",
      hookId: "hook-1",
      retryable: true,
      sourceType: "project",
    });

    expect(error.cause).toBe(cause);
    expect(error.toJSON()).toEqual({
      code: "HOOK_EXECUTION_FAILED",
      eventName: "PreToolUse",
      executorType: "command",
      hookId: "hook-1",
      message: "Hook execution failed.",
      name: "HookExecutionError",
      retryable: true,
      sourceType: "project",
    });
    expect(JSON.stringify(error.toJSON())).not.toContain("secret raw provider payload");
    expect(new HookError("HOOK_ABORTED", "Aborted.").toJSON()).toEqual({
      code: "HOOK_ABORTED",
      message: "Aborted.",
      name: "HookError",
      retryable: false,
    });
  });

  it("keeps existing hook errors and wraps unknown failures", () => {
    const existing = new HookError("HOOK_ABORTED", "aborted");

    expect(asHookError(existing, "HOOK_EXECUTION_FAILED", "fallback")).toBe(existing);

    const cause = new Error("provider detail");
    const wrapped = asHookError(cause, "HOOK_EXECUTION_FAILED", "Hook failed.", {
      hookId: "hook-2",
    });

    expect(wrapped).toMatchObject({
      cause,
      code: "HOOK_EXECUTION_FAILED",
      hookId: "hook-2",
      message: "Hook failed.",
    });
  });
});
