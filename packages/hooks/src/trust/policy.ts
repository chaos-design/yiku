import { HookSecurityError, HookTrustError } from "../errors.js";
import type { HookEventName, HookTrustRequest } from "../types.js";
import { createTrustKey, type HookTrustDescriptor } from "./canonical.js";
import type { HookTrustPolicyOptions, HookTrustResult } from "./types.js";

export class HookTrustPolicy {
  public constructor(private readonly options: HookTrustPolicyOptions) {}

  public async authorize(
    descriptor: HookTrustDescriptor,
    eventName?: HookEventName,
  ): Promise<HookTrustResult> {
    const key = createTrustKey(descriptor);

    if (descriptor.source.type === "runtime") {
      return trusted(key, "Runtime callbacks are trusted by their host.");
    }

    if (this.options.allowManagedHooksOnly === true && descriptor.source.type !== "managed") {
      throw new HookSecurityError(
        "HOOK_SECURITY_REJECTED",
        "Only managed Hooks are allowed by policy.",
        {
          executorType: descriptor.executorType,
          hookId: descriptor.hookId,
          sourceType: descriptor.source.type,
        },
      );
    }

    if (descriptor.opaque && this.options.allowOpaqueShell === false) {
      throw new HookSecurityError(
        "HOOK_SECURITY_REJECTED",
        "Opaque shell Hooks are disabled by policy.",
        {
          executorType: descriptor.executorType,
          hookId: descriptor.hookId,
          sourceType: descriptor.source.type,
        },
      );
    }

    if (descriptor.source.type === "managed" && this.options.managedHooksTrusted !== false) {
      return trusted(key, "Managed Hook source is pre-authorized.");
    }

    if (await this.options.store.has(descriptor)) {
      return trusted(key, "Hook capability hash is trusted.");
    }

    const approvalHandler = this.options.approvalHandler;
    if (approvalHandler === undefined) {
      throw trustRequired(descriptor, "Hook requires explicit trust approval.");
    }

    const response = await approvalHandler(toTrustRequest(descriptor, eventName));

    if (response.decision !== "allow") {
      throw trustRequired(descriptor, response.reason ?? "Hook trust approval was denied.");
    }

    const scope = response.scope ?? "persistent";
    if (scope !== "once" && scope !== "persistent") {
      throw trustRequired(descriptor, `Unsupported Hook trust scope: ${String(response.scope)}.`);
    }

    if (scope === "once") {
      return trusted(key, response.reason ?? "Hook capability was approved for this run.");
    }

    await this.options.store.approve(descriptor);
    return trusted(key, response.reason ?? "Hook capability was explicitly approved.");
  }
}

function toTrustRequest(
  descriptor: HookTrustDescriptor,
  eventName?: HookEventName,
): HookTrustRequest {
  return {
    capability: descriptor.capability,
    ...(eventName !== undefined ? { eventName } : {}),
    executorType: descriptor.executorType,
    handlerHash: descriptor.handlerHash,
    hookId: descriptor.hookId,
    opaque: descriptor.opaque,
    source: descriptor.source,
    trustKey: createTrustKey(descriptor),
  };
}

function trustRequired(descriptor: HookTrustDescriptor, message: string): HookTrustError {
  return new HookTrustError("HOOK_TRUST_REQUIRED", message, {
    executorType: descriptor.executorType,
    hookId: descriptor.hookId,
    sourceType: descriptor.source.type,
  });
}

function trusted(key: string, reason: string): HookTrustResult {
  return {
    key,
    reason,
    trusted: true,
  };
}
