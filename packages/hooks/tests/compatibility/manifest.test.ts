import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOKS_COMPATIBILITY_VERSION,
  getHookEventCapability,
  HOOK_EVENT_CAPABILITIES,
  RUNTIME_HOOK_EVENT_NAMES,
} from "../../src/compatibility/manifest.js";
import { HOOK_EVENT_NAMES } from "../../src/types.js";

describe("compatibility manifest", () => {
  it("pins the compatibility version and covers every public event", () => {
    expect(CLAUDE_HOOKS_COMPATIBILITY_VERSION).toBe("claude-hooks@2026-08-01");
    expect(Object.keys(HOOK_EVENT_CAPABILITIES).sort()).toEqual([...HOOK_EVENT_NAMES].sort());
  });

  it("marks every Hook event as runtime supported", () => {
    expect(RUNTIME_HOOK_EVENT_NAMES).toHaveLength(30);
    expect(
      HOOK_EVENT_NAMES.filter((name) => !getHookEventCapability(name).runtimeSupported),
    ).toEqual([]);
    expect(getHookEventCapability("WorktreeCreate").decisions).toEqual(
      expect.arrayContaining(["block", "defer", "modify"]),
    );
    expect(getHookEventCapability("WorktreeRemove").decisions).toEqual(
      expect.arrayContaining(["block", "defer"]),
    );
  });

  it("keeps permission and tool decisions explicit", () => {
    expect(getHookEventCapability("PreToolUse")).toMatchObject({
      exitCodeTwo: "block",
      matcherField: "tool_name",
      runtimeSupported: true,
    });
    expect(getHookEventCapability("PreToolUse").decisions).toEqual(
      expect.arrayContaining(["allow", "block", "defer", "modify"]),
    );
    expect(getHookEventCapability("Notification")).toMatchObject({
      exitCodeTwo: "ignore",
      matcherField: "notification_type",
    });
  });

  it("freezes capabilities and nested arrays", () => {
    const capability = getHookEventCapability("Stop");

    expect(Object.isFrozen(HOOK_EVENT_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.decisions)).toBe(true);
    expect(Object.isFrozen(capability.handlers)).toBe(true);
  });
});
