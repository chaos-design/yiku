import { describe, expect, it } from "vitest";
import type { HookControllerEntry } from "../../src/hooks/controller.js";
import {
  presentHookDryRun,
  presentHookInspection,
  presentHookList,
  presentRecentHookEvents,
} from "../../src/hooks/presentation.js";

describe("Hook presentation", () => {
  it("renders empty and populated Hook lists", () => {
    expect(presentHookList([])).toContain("No Hooks");
    expect(presentHookList([entry()])).toContain(
      "hook_test  Stop  command  project  enabled  untrusted",
    );
  });

  it("renders inspection, dry-run, and recent operation details", () => {
    expect(presentHookInspection(entry())).toContain("Handler hash: abcdef1234567890");
    expect(
      presentHookDryRun({
        entry: entry(),
        executable: false,
        message: "No external executor was invoked.",
      }),
    ).toContain("Executable: no");
    expect(presentRecentHookEvents([])).toContain("No recent");
    expect(
      presentRecentHookEvents([
        {
          durationMs: 4,
          hookId: "hook_test",
          operation: "execute",
          operationId: "operation-1",
          outcome: "success",
          phase: "end",
          startedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
    ).toContain("hook_test  success 4ms");
  });

  it("renders disabled, trusted, unsupported, and fallback operation states", () => {
    const { sourcePath: _sourcePath, ...baseEntry } = entry();
    const alternate: HookControllerEntry = {
      ...baseEntry,
      enabled: false,
      opaque: false,
      runtimeSupported: false,
      trusted: true,
    };

    expect(presentHookList([alternate])).toContain("disabled  trusted");
    expect(presentHookInspection(alternate)).toContain("Source: project\n");
    expect(presentHookInspection(alternate)).toContain("Runtime supported: no");
    expect(presentHookInspection(alternate)).toContain("Opaque shell: no");
    expect(
      presentHookDryRun({
        entry: alternate,
        executable: true,
        message: "Validated.",
      }),
    ).toContain("Executable: yes");
    expect(
      presentRecentHookEvents([
        {
          code: "HOOK_TIMEOUT",
          eventName: "Stop",
          operation: "dispatch",
          operationId: "event-target",
          phase: "error",
          startedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          operation: "dispatch",
          operationId: "engine-target",
          phase: "start",
          startedAt: "2026-08-01T00:00:01.000Z",
        },
      ]),
    ).toContain("engine  start");
  });
});

function entry(overrides: Partial<HookControllerEntry> = {}): HookControllerEntry {
  return {
    capability: "command:/bin/sh:echo ok",
    enabled: true,
    eventName: "Stop",
    executorType: "command",
    handlerHash: "abcdef1234567890",
    hookId: "hook_test",
    jsonPointer: "/hooks/Stop/0/hooks/0",
    opaque: true,
    runtimeSupported: true,
    sourcePath: "/workspace/.yiku/settings.json",
    sourceType: "project",
    trustKey: "trust_test",
    trusted: false,
    ...overrides,
  };
}
