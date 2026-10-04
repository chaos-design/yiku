import { describe, expect, it } from "vitest";
import { HookCapabilityError, HookConfigError } from "../../src/errors.js";
import { HookExecutorRegistry } from "../../src/executors/registry.js";
import type { HookExecutor } from "../../src/types.js";

describe("HookExecutorRegistry", () => {
  it("registers, lists, and resolves executors", () => {
    const command = executor("command");
    const callback = executor("callback");
    const registry = new HookExecutorRegistry([command, callback]);

    expect(registry.list()).toEqual(["callback", "command"]);
    expect(registry.has("command")).toBe(true);
    expect(registry.get("command")).toBe(command);
  });

  it("rejects duplicates and unavailable executors", () => {
    expect(() => new HookExecutorRegistry([executor("command"), executor("command")])).toThrow(
      HookConfigError,
    );
    expect(() => new HookExecutorRegistry().get("mcp")).toThrow(HookCapabilityError);
  });
});

function executor(type: HookExecutor["type"]): HookExecutor {
  return {
    async execute() {
      return {
        durationMs: 0,
        endedAt: "2026-08-01T00:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z",
        status: "success",
      };
    },
    type,
  };
}
