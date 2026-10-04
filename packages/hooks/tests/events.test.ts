import { describe, expect, it, vi } from "vitest";
import { HookEvents, type HookOperationEvent } from "../src/events.js";

describe("HookEvents", () => {
  it("emits content-free operation metadata", () => {
    const handler = vi.fn();
    const events = new HookEvents(handler);
    const event = operationEvent();

    events.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(JSON.stringify(event)).not.toContain("prompt");
    expect(JSON.stringify(event)).not.toContain("tool_input");
    expect(JSON.stringify(event)).not.toContain("environment");
  });

  it("isolates observer failures without recursive emission", () => {
    const handler = vi.fn(() => {
      throw new Error("observer failed");
    });
    const events = new HookEvents(handler);

    expect(() => events.emit(operationEvent())).not.toThrow();
    expect(handler).toHaveBeenCalledOnce();
  });
});

function operationEvent(): HookOperationEvent {
  return {
    eventName: "PreToolUse",
    executorType: "command",
    hookId: "hook-1",
    invocationId: "invocation-1",
    operation: "execute",
    operationId: "operation-1",
    phase: "start",
    sourceType: "project",
    startedAt: "2026-08-01T00:00:00.000Z",
  };
}
