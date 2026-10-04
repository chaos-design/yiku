import {
  createTrustKey,
  HookConfigCompiler,
  HookEngine,
  type HookTrustDescriptor,
  type HookTrustEntry,
  type HookTrustStoreContract,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { describeHookTrust, HookController } from "../../src/hooks/controller.js";

describe("HookController", () => {
  it("lists, inspects, trusts, revokes, disables, and enables Hooks", async () => {
    const store = new MemoryTrustStore();
    const engine = engineWith("echo first");
    const controller = new HookController({ engine, trustStore: store });
    const [initial] = await controller.list();

    expect(initial).toMatchObject({
      enabled: true,
      eventName: "Stop",
      executorType: "command",
      sourceType: "project",
      trusted: false,
    });
    if (initial === undefined) {
      throw new Error("Expected a compiled Hook.");
    }

    await expect(controller.inspect(initial.hookId)).resolves.toEqual(initial);
    await expect(controller.trust(initial.hookId)).resolves.toMatchObject({ trusted: true });
    await expect(controller.dryRun(initial.hookId)).resolves.toMatchObject({
      executable: true,
    });
    await expect(controller.disable(initial.hookId)).resolves.toMatchObject({ enabled: false });
    expect(engine.currentSnapshot().hooks).toHaveLength(0);
    await expect(controller.dryRun(initial.hookId)).resolves.toMatchObject({
      executable: false,
    });
    await expect(controller.enable(initial.hookId)).resolves.toMatchObject({ enabled: true });
    expect(engine.currentSnapshot().hooks).toHaveLength(1);
    await expect(controller.revoke(initial.hookId)).resolves.toMatchObject({ trusted: false });
    await expect(controller.inspect("missing")).rejects.toThrow("Unknown Hook ID");
  });

  it("adopts hot-reloaded snapshots and retains only applicable disabled IDs", async () => {
    const store = new MemoryTrustStore();
    const engine = engineWith("echo first");
    const controller = new HookController({ engine, trustStore: store });
    const [first] = await controller.list();

    if (first === undefined) {
      throw new Error("Expected a compiled Hook.");
    }
    await controller.disable(first.hookId);
    engine.replaceSnapshot(snapshotWith("echo second"));

    const [second] = await controller.list();
    expect(second?.hookId).not.toBe(first.hookId);
    expect(second?.enabled).toBe(true);
  });

  it("keeps bounded recent operations and exposes active status messages", async () => {
    const status = vi.fn();
    const controller = new HookController({
      engine: engineWith("echo status", "Checking policy"),
      recentLimit: 2,
      trustStore: new MemoryTrustStore(),
    });
    controller.setStatusMessageHandler(status);
    const [entry] = await controller.list();

    if (entry === undefined) {
      throw new Error("Expected a compiled Hook.");
    }

    controller.record(operation(entry.hookId, "start", "one"));
    controller.record(operation(entry.hookId, "end", "one"));
    controller.record(operation(entry.hookId, "start", "two"));

    expect(controller.recent()).toHaveLength(2);
    expect(status).toHaveBeenCalledWith("Checking policy");
    expect(status).toHaveBeenCalledWith(undefined);
  });

  it("handles trusted sources, non-execute audit, missing status hooks, and trust descriptions", async () => {
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("managed", { componentId: "policy" }),
        value: {
          hooks: {
            Stop: [{ hooks: [{ command: "managed", type: "command" }] }],
          },
        },
      },
    ]).snapshot;
    const engine = new HookEngine({ snapshot });
    const controller = new HookController({
      engine,
      recentLimit: 0,
      trustStore: new MemoryTrustStore(),
    });
    const [entry] = await controller.list();

    expect(entry).toMatchObject({
      sourceComponentId: "policy",
      trusted: true,
    });
    if (entry === undefined) {
      throw new Error("Expected a managed Hook.");
    }

    controller.record({
      operation: "dispatch",
      operationId: "dispatch",
      phase: "start",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    controller.record({
      operation: "execute",
      operationId: "missing-hook",
      phase: "start",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(controller.recent()).toHaveLength(1);
    expect(
      describeHookTrust({
        capability: entry.capability,
        executorType: entry.executorType,
        handlerHash: entry.handlerHash,
        hookId: entry.hookId,
        opaque: entry.opaque,
        source: snapshot.hooks[0]?.source ?? hookSource("managed"),
      }),
    ).toContain("source=managed");
  });
});

function engineWith(command: string, statusMessage?: string): HookEngine {
  return new HookEngine({
    snapshot: snapshotWith(command, statusMessage),
  });
}

function snapshotWith(command: string, statusMessage?: string) {
  return new HookConfigCompiler().compile([
    {
      source: hookSource("project", { path: "/workspace/.yiku/settings.json" }),
      value: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  command,
                  ...(statusMessage !== undefined ? { statusMessage } : {}),
                  type: "command",
                },
              ],
            },
          ],
        },
      },
    },
  ]).snapshot;
}

function operation(
  hookId: string,
  phase: "end" | "start",
  operationId: string,
): Parameters<HookController["record"]>[0] {
  return {
    hookId,
    operation: "execute",
    operationId,
    phase,
    startedAt: "2026-08-01T00:00:00.000Z",
  };
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
