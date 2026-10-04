import { describe, expect, it, vi } from "vitest";
import { hookSource } from "../../src/config/source.js";
import { HookSecurityError, HookTrustError } from "../../src/errors.js";
import { createTrustKey, type HookTrustDescriptor, sha256 } from "../../src/trust/canonical.js";
import { HookTrustPolicy } from "../../src/trust/policy.js";
import type { HookTrustEntry, HookTrustStoreContract } from "../../src/trust/types.js";

describe("HookTrustPolicy", () => {
  it("trusts runtime and managed sources without persistence", async () => {
    const store = new MemoryTrustStore();
    const policy = new HookTrustPolicy({ store });

    await expect(policy.authorize(descriptor("runtime"))).resolves.toMatchObject({
      trusted: true,
    });
    await expect(policy.authorize(descriptor("managed"))).resolves.toMatchObject({
      trusted: true,
    });
    expect(await store.list()).toEqual([]);
  });

  it("reuses stored trust and explicitly approved capabilities", async () => {
    const store = new MemoryTrustStore();
    const approved = descriptor("project");
    await store.approve(approved);
    const approvalHandler = vi.fn(() => ({ decision: "allow" as const }));
    const policy = new HookTrustPolicy({ approvalHandler, store });

    await expect(policy.authorize(approved)).resolves.toMatchObject({
      reason: "Hook capability hash is trusted.",
    });
    expect(approvalHandler).not.toHaveBeenCalled();

    const next = { ...approved, capability: "node other.mjs" };
    await expect(policy.authorize(next, "PreCompact")).resolves.toMatchObject({
      trusted: true,
    });
    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "PreCompact" }),
    );
    expect(await store.has(next)).toBe(true);
  });

  it("supports one-time trust without persisting the descriptor", async () => {
    const store = new MemoryTrustStore();
    const oneTime = descriptor("project");
    const approvalHandler = vi.fn(() => ({
      decision: "allow" as const,
      scope: "once" as const,
    }));
    const policy = new HookTrustPolicy({ approvalHandler, store });

    await expect(policy.authorize(oneTime)).resolves.toMatchObject({
      reason: "Hook capability was approved for this run.",
      trusted: true,
    });
    expect(approvalHandler).toHaveBeenCalledOnce();
    expect(await store.has(oneTime)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("fails closed without approval and preserves denial reasons", async () => {
    const store = new MemoryTrustStore();

    await expect(
      new HookTrustPolicy({ store }).authorize(descriptor("project")),
    ).rejects.toBeInstanceOf(HookTrustError);
    await expect(
      new HookTrustPolicy({
        approvalHandler: () => ({ decision: "deny", reason: "Not reviewed." }),
        store,
      }).authorize(descriptor("project")),
    ).rejects.toThrow("Not reviewed.");
  });

  it("enforces managed-only and opaque-shell policy", async () => {
    const store = new MemoryTrustStore();

    await expect(
      new HookTrustPolicy({
        allowManagedHooksOnly: true,
        store,
      }).authorize(descriptor("user")),
    ).rejects.toBeInstanceOf(HookSecurityError);
    await expect(
      new HookTrustPolicy({
        allowOpaqueShell: false,
        store,
      }).authorize(descriptor("project")),
    ).rejects.toThrow("Opaque shell");
  });
});

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

function descriptor(sourceType: "managed" | "project" | "runtime" | "user"): HookTrustDescriptor {
  return {
    capability: "node hook.mjs",
    executorType: sourceType === "runtime" ? "callback" : "command",
    handlerHash: sha256("handler"),
    hookId: "hook-1",
    opaque: sourceType !== "runtime",
    source: hookSource(sourceType),
  };
}
