import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNTIME_HOOK_EVENT_NAMES } from "../../src/compatibility/manifest.js";
import { HookConfigCompiler } from "../../src/config/compiler.js";
import { hookSource } from "../../src/config/source.js";
import { HookEngine } from "../../src/engine.js";
import { CallbackHookExecutor } from "../../src/executors/callback.js";
import { HookExecutorRegistry } from "../../src/executors/registry.js";
import { HookSession } from "../../src/session.js";
import {
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  type HookInvocation,
} from "../../src/types.js";

const events = JSON.parse(
  readFileSync(new URL("./fixtures/events/valid.json", import.meta.url), "utf8"),
) as HookEvent[];

describe("Runtime Hook conformance", () => {
  it("executes all 30 runtime events including Worktree lifecycle Hooks", async () => {
    const observed: HookEventName[] = [];
    const hooks = Object.fromEntries(
      HOOK_EVENT_NAMES.map((eventName) => [
        eventName,
        [
          {
            hooks: [
              {
                callback: (invocation: HookInvocation) => {
                  observed.push(invocation.event.hook_event_name);
                  return {};
                },
                name: `runtime-${eventName}`,
                type: "callback",
              },
            ],
          },
        ],
      ]),
    );
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("runtime"),
        value: { hooks },
      },
    ]).snapshot;
    const session = new HookSession({
      engine: new HookEngine({
        executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
        snapshot,
      }),
    });

    try {
      const decisions = new Map<HookEventName, Awaited<ReturnType<HookSession["dispatch"]>>>();
      for (const event of events) {
        decisions.set(event.hook_event_name, await session.dispatch(event));
      }

      expect(observed).toEqual(RUNTIME_HOOK_EVENT_NAMES);
      expect(decisions.get("WorktreeCreate")?.diagnostics).toEqual([]);
      expect(decisions.get("WorktreeRemove")?.diagnostics).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
