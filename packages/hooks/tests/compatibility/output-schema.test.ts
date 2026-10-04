import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hookHandlerOutputSchema,
  parseHookHandlerOutput,
} from "../../src/compatibility/output-schema.js";
import { HookProtocolError } from "../../src/errors.js";
import type { HookEventName, HookHandlerOutput } from "../../src/types.js";

interface OutputFixture {
  readonly eventName: HookEventName;
  readonly output: HookHandlerOutput;
}

const validOutputs = JSON.parse(
  readFileSync(new URL("./fixtures/results/valid.json", import.meta.url), "utf8"),
) as OutputFixture[];

describe("hook output schema", () => {
  it("parses compatible event-specific output fixtures", () => {
    for (const fixture of validOutputs) {
      expect(parseHookHandlerOutput(fixture.eventName, fixture.output)).toEqual(fixture.output);
    }
  });

  it("rejects a mismatched hook-specific event", () => {
    expect(() =>
      parseHookHandlerOutput("PreToolUse", {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          permissionDecision: "deny",
        },
      }),
    ).toThrow(HookProtocolError);
  });

  it("rejects decisions unsupported by the event", () => {
    expect(() =>
      parseHookHandlerOutput("Notification", {
        decision: "block",
      }),
    ).toThrow("does not support blocking");
    expect(() =>
      parseHookHandlerOutput("Stop", {
        updatedInput: { value: "changed" },
      }),
    ).toThrow("does not support output modification");
    expect(() =>
      parseHookHandlerOutput("SessionEnd", {
        additionalContext: "late context",
      }),
    ).toThrow("does not support additional context");
    expect(() =>
      parseHookHandlerOutput("Stop", {
        action: "defer",
      }),
    ).toThrow("does not support deferred");
    expect(() =>
      parseHookHandlerOutput("Notification", {
        action: "stop",
      }),
    ).toThrow("does not support stop");
    expect(() =>
      parseHookHandlerOutput("Notification", {
        hookSpecificOutput: {
          hookEventName: "Notification",
          permissionDecision: "deny",
        },
      }),
    ).toThrow("permissionDecision is only valid");
  });

  it("rejects unknown output fields and malformed permission updates", () => {
    expect(hookHandlerOutputSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(
      hookHandlerOutputSchema.safeParse({
        permissionUpdates: [{ decision: "maybe" }],
      }).success,
    ).toBe(false);
  });

  it("keeps protocol causes out of the public error message", () => {
    try {
      parseHookHandlerOutput("PreToolUse", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          unknown: "secret",
        },
      });
      throw new Error("Expected parseHookHandlerOutput to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(HookProtocolError);
      expect((error as Error).message).toBe("Hook output is invalid for PreToolUse.");
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
