import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHookEvent } from "../../src/compatibility/event-schema.js";
import { parseHookHandler } from "../../src/compatibility/handler-schema.js";
import { parseHookHandlerOutput } from "../../src/compatibility/output-schema.js";
import { HookConfigCompiler } from "../../src/config/compiler.js";
import { hookSource } from "../../src/config/source.js";
import { HookEngine } from "../../src/engine.js";
import { CommandHookExecutor } from "../../src/executors/command.js";
import { HookExecutorRegistry } from "../../src/executors/registry.js";
import { HookSession } from "../../src/session.js";
import { createTrustKey, type HookTrustDescriptor } from "../../src/trust/canonical.js";
import { HookTrustPolicy } from "../../src/trust/policy.js";
import type { HookTrustEntry, HookTrustStoreContract } from "../../src/trust/types.js";
import type { HookEvent, HookHandlerOutput } from "../../src/types.js";

const events = fixture<HookEvent>("events/valid.json");
const handlers = fixture<unknown[]>("handlers/valid.json");
const results =
  fixture<Array<{ eventName: HookEvent["hook_event_name"]; output: HookHandlerOutput }>>(
    "results/valid.json",
  );

describe("Claude Hook conformance", () => {
  it("loads every local compatibility fixture through public parsers", () => {
    expect(events.map(parseHookEvent)).toEqual(events);
    expect(handlers.map(parseHookHandler)).toEqual(handlers);
    expect(results.map((item) => parseHookHandlerOutput(item.eventName, item.output))).toEqual(
      results.map((item) => item.output),
    );
  });

  it("compiles real settings and normalizes command stdin, JSON, and exit code 2", async () => {
    const eventFixture = events.find((item) => item.hook_event_name === "PreToolUse");
    if (eventFixture === undefined) {
      throw new Error("PreToolUse fixture is required.");
    }
    const event = {
      ...eventFixture,
      cwd: process.cwd(),
    };
    const commandFixture = fileURLToPath(
      new URL("../executors/fixtures/command-fixture.mjs", import.meta.url),
    );
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("managed"),
        value: {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    args: [commandFixture, "context"],
                    command: process.execPath,
                    type: "command",
                  },
                  {
                    args: [commandFixture, "block"],
                    command: process.execPath,
                    type: "command",
                  },
                ],
                matcher: "Bash",
              },
            ],
          },
        },
      },
    ]).snapshot;
    const store = new MemoryTrustStore();
    const session = new HookSession({
      engine: new HookEngine({
        executors: new HookExecutorRegistry([new CommandHookExecutor()]),
        snapshot,
        trustPolicy: new HookTrustPolicy({ store }),
      }),
    });

    try {
      const decision = await session.dispatch(event);
      expect(decision.action).toBe("block");
      expect(decision.reasons).toEqual(["blocked by fixture"]);
      expect(decision.additionalContext).toHaveLength(1);
      expect(JSON.parse(decision.additionalContext[0] ?? "{}")).toMatchObject({
        eventName: "PreToolUse",
        projectDir: event.cwd,
        sessionId: event.session_id,
      });
    } finally {
      await session.close();
    }
  });
});

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8")) as T;
}

class MemoryTrustStore implements HookTrustStoreContract {
  private readonly entries = new Map<string, HookTrustEntry>();

  public async approve(descriptor: HookTrustDescriptor): Promise<HookTrustEntry> {
    const key = createTrustKey(descriptor);
    const entry = {
      approvedAt: "2026-08-01T00:00:00.000Z",
      descriptor,
      key,
    };
    this.entries.set(key, entry);
    return entry;
  }

  public async has(descriptor: HookTrustDescriptor): Promise<boolean> {
    return this.entries.has(createTrustKey(descriptor));
  }

  public async list(): Promise<readonly HookTrustEntry[]> {
    return [...this.entries.values()];
  }

  public async revoke(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}
