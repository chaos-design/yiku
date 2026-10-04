import { describe, expect, it } from "vitest";
import { HookProtocolError } from "../../src/errors.js";
import { parseCommandHookResult } from "../../src/executors/command-result.js";

describe("parseCommandHookResult", () => {
  it("parses empty, JSON, and plain successful output", () => {
    expect(
      parseCommandHookResult({
        eventName: "SessionStart",
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
    ).toEqual({ status: "success" });
    expect(
      parseCommandHookResult({
        eventName: "SessionStart",
        exitCode: 0,
        stderr: "",
        stdout: '{"additionalContext":"from json"}',
      }),
    ).toMatchObject({
      output: { additionalContext: "from json" },
      status: "success",
    });
    expect(
      parseCommandHookResult({
        eventName: "SessionStart",
        exitCode: 0,
        stderr: "",
        stdout: "plain context",
      }),
    ).toMatchObject({
      output: { additionalContext: "plain context" },
    });
    expect(
      parseCommandHookResult({
        eventName: "Notification",
        exitCode: 0,
        stderr: "",
        stdout: "delivered",
      }),
    ).toMatchObject({
      output: { systemMessage: "delivered" },
    });
  });

  it("maps exit code two through event capabilities", () => {
    expect(
      parseCommandHookResult({
        eventName: "PreToolUse",
        exitCode: 2,
        stderr: "blocked",
        stdout: "",
      }),
    ).toMatchObject({
      output: { action: "block", reason: "blocked" },
      status: "success",
    });
    expect(
      parseCommandHookResult({
        eventName: "PostToolUse",
        exitCode: 2,
        stderr: "feedback",
        stdout: "",
      }),
    ).toMatchObject({
      output: { additionalContext: "feedback" },
    });
    expect(
      parseCommandHookResult({
        eventName: "Notification",
        exitCode: 2,
        stderr: "ignored",
        stdout: "",
      }),
    ).toEqual({ status: "success" });
  });

  it("returns visible non-blocking errors for other exit codes", () => {
    expect(
      parseCommandHookResult({
        eventName: "Stop",
        exitCode: 1,
        stderr: "failed",
        stdout: "",
      }),
    ).toEqual({
      errorCode: "HOOK_EXECUTION_FAILED",
      output: { systemMessage: "failed" },
      status: "error",
    });
  });

  it("rejects malformed or incompatible JSON output", () => {
    expect(() =>
      parseCommandHookResult({
        eventName: "PreToolUse",
        exitCode: 0,
        stderr: "",
        stdout: "{",
      }),
    ).toThrow(HookProtocolError);
    expect(() =>
      parseCommandHookResult({
        eventName: "Notification",
        exitCode: 0,
        stderr: "",
        stdout: '{"decision":"block"}',
      }),
    ).toThrow("does not support blocking");
  });
});
