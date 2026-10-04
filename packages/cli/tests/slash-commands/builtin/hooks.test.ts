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
import { HookController } from "../../../src/hooks/controller.js";
import { hooksCommand } from "../../../src/slash-commands/builtin/hooks.js";

describe("/hooks", () => {
  it("executes all management subcommands", async () => {
    const store = new MemoryTrustStore();
    const snapshot = new HookConfigCompiler().compile([
      {
        source: hookSource("project"),
        value: {
          hooks: {
            Stop: [{ hooks: [{ command: "echo ok", type: "command" }] }],
          },
        },
      },
    ]).snapshot;
    const controller = new HookController({
      engine: new HookEngine({ snapshot }),
      trustStore: store,
    });
    const [entry] = await controller.list();
    if (entry === undefined) {
      throw new Error("Expected a Hook.");
    }
    const context = commandContext(controller);

    await expect(execute(context, [])).resolves.toMatchObject({
      kind: "success",
      message: expect.stringContaining("Hook commands:"),
    });
    await expect(execute(context, ["list"])).resolves.toMatchObject({
      message: expect.stringContaining(entry.hookId),
    });
    await expect(execute(context, ["inspect", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining(`Hook: ${entry.hookId}`),
    });
    await expect(execute(context, ["trust", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining("Trusted"),
    });
    await expect(execute(context, ["disable", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining("Disabled"),
    });
    await expect(execute(context, ["dry-run", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining("Executable: no"),
    });
    await expect(execute(context, ["enable", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining("Enabled"),
    });
    await expect(execute(context, ["revoke", entry.hookId])).resolves.toMatchObject({
      message: expect.stringContaining("Revoked"),
    });
    await expect(execute(context, ["recent"])).resolves.toMatchObject({
      message: "No recent Hook operations.",
    });
  });

  it("returns typed errors for invalid commands and unavailable management", async () => {
    const unavailable = commandContext(undefined);

    await expect(execute(unavailable, ["list"])).resolves.toEqual({
      kind: "error",
      message: "Hook management is unavailable in this session.",
      title: "Command Error",
    });

    const controller = new HookController({
      engine: new HookEngine({ snapshot: new HookConfigCompiler().compile([]).snapshot }),
      trustStore: new MemoryTrustStore(),
    });
    await expect(execute(commandContext(controller), ["unknown"])).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unknown /hooks action"),
    });
    await expect(execute(commandContext(controller), ["list", "hook-extra"])).resolves.toEqual({
      kind: "error",
      message: "Usage: /hooks list",
      title: "Command Error",
    });
    await expect(
      execute(commandContext(controller), ["list", "one", "two"]),
    ).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("Too many"),
    });

    for (const action of ["inspect", "trust", "revoke", "enable", "disable", "dry-run"]) {
      await expect(execute(commandContext(controller), [action])).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("Usage:"),
      });
    }

    await expect(execute(commandContext(controller), ["recent", "hook-extra"])).resolves.toEqual({
      kind: "error",
      message: "Usage: /hooks recent",
      title: "Command Error",
    });
    await expect(
      execute(commandContext(controller), ["inspect", "missing"]),
    ).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unknown Hook ID"),
    });
    vi.spyOn(controller, "list").mockRejectedValueOnce("string failure");
    await expect(execute(commandContext(controller), ["list"])).resolves.toEqual({
      kind: "error",
      message: "string failure",
      title: "Command Error",
    });
  });
});

function execute(context: ReturnType<typeof commandContext>, values: readonly string[]) {
  return hooksCommand.execute(context, { raw: values.join(" "), values });
}

function commandContext(controller: HookController | undefined) {
  return {
    cancelActiveRun: vi.fn(),
    clearMessages: vi.fn(),
    clearQueuedPrompts: vi.fn(),
    clearSession: vi.fn(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    createAgent: vi.fn(),
    exit: vi.fn(),
    getContextSummary: vi.fn(() => ""),
    getContextUsage: vi.fn(() => undefined),
    getHookController: vi.fn(async () => controller),
    getMemoryController: vi.fn(async () => undefined),
    getSessionStatus: vi.fn(() => ""),
    getTaskSummary: vi.fn(() => ""),
    getUsageSummary: vi.fn(() => ""),
    listAgents: vi.fn(async () => []),
    listCommands: vi.fn(() => []),
    listSkills: vi.fn(() => []),
    onExitCode: vi.fn(),
    removeAgent: vi.fn(),
    runAgent: vi.fn(),
    runSetup: vi.fn(async () => undefined),
    showAgent: vi.fn(),
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
