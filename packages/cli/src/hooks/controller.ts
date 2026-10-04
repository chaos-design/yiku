import {
  buildHookTrustDescriptor,
  type CompiledHook,
  createTrustKey,
  getHookEventCapability,
  HookConfigSnapshot,
  type HookConfigSnapshotView,
  type HookEngine,
  type HookOperationEvent,
  type HookTrustDescriptor,
  type HookTrustStoreContract,
  sha256,
} from "@yiku/hooks";

const DEFAULT_RECENT_LIMIT = 50;

export interface HookControllerOptions {
  readonly engine: HookEngine;
  readonly recentLimit?: number | undefined;
  readonly trustStore: HookTrustStoreContract;
}

export interface HookControllerEntry {
  readonly capability: string;
  readonly enabled: boolean;
  readonly eventName: CompiledHook["eventName"];
  readonly executorType: CompiledHook["handler"]["type"];
  readonly handlerHash: string;
  readonly hookId: string;
  readonly jsonPointer: string;
  readonly opaque: boolean;
  readonly runtimeSupported: boolean;
  readonly sourceComponentId?: string | undefined;
  readonly sourcePath?: string | undefined;
  readonly sourceType: CompiledHook["source"]["type"];
  readonly statusMessage?: string | undefined;
  readonly trustKey: string;
  readonly trusted: boolean;
}

export interface HookDryRunResult {
  readonly entry: HookControllerEntry;
  readonly executable: boolean;
  readonly message: string;
}

export type HookStatusMessageHandler = (message: string | undefined) => void;

export class HookController {
  private appliedSnapshot: HookConfigSnapshotView;
  private baseSnapshot: HookConfigSnapshotView;
  private readonly disabledHookIds = new Set<string>();
  private readonly activeStatusMessages = new Map<string, string>();
  private readonly recentEvents: HookOperationEvent[] = [];
  private readonly recentLimit: number;
  private statusMessageHandler?: HookStatusMessageHandler | undefined;

  public constructor(private readonly options: HookControllerOptions) {
    this.baseSnapshot = options.engine.currentSnapshot();
    this.appliedSnapshot = this.baseSnapshot;
    this.recentLimit = Math.max(1, options.recentLimit ?? DEFAULT_RECENT_LIMIT);
  }

  public async list(): Promise<readonly HookControllerEntry[]> {
    this.synchronizeSnapshot();
    return Promise.all(this.baseSnapshot.hooks.map((hook) => this.toEntry(hook)));
  }

  public async inspect(hookId: string): Promise<HookControllerEntry> {
    return this.toEntry(this.requireHook(hookId));
  }

  public async trust(hookId: string): Promise<HookControllerEntry> {
    const hook = this.requireHook(hookId);
    await this.options.trustStore.approve(buildHookTrustDescriptor(hook));
    return this.toEntry(hook);
  }

  public async revoke(hookId: string): Promise<HookControllerEntry> {
    const hook = this.requireHook(hookId);
    await this.options.trustStore.revoke(createTrustKey(buildHookTrustDescriptor(hook)));
    return this.toEntry(hook);
  }

  public async enable(hookId: string): Promise<HookControllerEntry> {
    const hook = this.requireHook(hookId);
    this.disabledHookIds.delete(hookId);
    this.applyDisabledHooks();
    return this.toEntry(hook);
  }

  public async disable(hookId: string): Promise<HookControllerEntry> {
    const hook = this.requireHook(hookId);
    this.disabledHookIds.add(hookId);
    this.applyDisabledHooks();
    return this.toEntry(hook);
  }

  public async dryRun(hookId: string): Promise<HookDryRunResult> {
    const entry = await this.inspect(hookId);
    const executable = entry.enabled && entry.runtimeSupported && entry.trusted;

    return {
      entry,
      executable,
      message: executable
        ? "Hook configuration, runtime capability, and trust checks passed. No external executor was invoked."
        : "Hook is not currently executable. No external executor was invoked.",
    };
  }

  public recent(): readonly HookOperationEvent[] {
    return Object.freeze([...this.recentEvents]);
  }

  public record(event: HookOperationEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.recentLimit) {
      this.recentEvents.splice(0, this.recentEvents.length - this.recentLimit);
    }

    if (event.operation !== "execute") {
      return;
    }

    if (event.phase === "start" && event.hookId !== undefined) {
      const statusMessage = this.findHook(event.hookId)?.handler.statusMessage;
      if (statusMessage !== undefined) {
        this.activeStatusMessages.set(event.operationId, statusMessage);
      }
    } else {
      this.activeStatusMessages.delete(event.operationId);
    }

    this.emitStatusMessage();
  }

  public setStatusMessageHandler(handler?: HookStatusMessageHandler): void {
    this.statusMessageHandler = handler;
    this.emitStatusMessage();
  }

  private synchronizeSnapshot(): void {
    const current = this.options.engine.currentSnapshot();
    if (current === this.appliedSnapshot) {
      return;
    }

    this.baseSnapshot = current;
    this.disabledHookIds.forEach((hookId) => {
      if (!this.baseSnapshot.hooks.some((hook) => hook.hookId === hookId)) {
        this.disabledHookIds.delete(hookId);
      }
    });
    this.applyDisabledHooks();
  }

  private applyDisabledHooks(): void {
    const disabled = [...this.disabledHookIds].sort();
    const snapshot = new HookConfigSnapshot({
      diagnostics: this.baseSnapshot.diagnostics,
      hooks: this.baseSnapshot.hooks.filter((hook) => !this.disabledHookIds.has(hook.hookId)),
      version: `${this.baseSnapshot.version}:cli:${sha256(disabled.join("\n")).slice(0, 12)}`,
    });
    this.appliedSnapshot = snapshot;
    this.options.engine.replaceSnapshot(snapshot);
  }

  private requireHook(hookId: string): CompiledHook {
    this.synchronizeSnapshot();
    const hook = this.findHook(hookId);
    if (hook === undefined) {
      throw new Error(`Unknown Hook ID: ${hookId}.`);
    }
    return hook;
  }

  private findHook(hookId: string): CompiledHook | undefined {
    return this.baseSnapshot.hooks.find((hook) => hook.hookId === hookId);
  }

  private async toEntry(hook: CompiledHook): Promise<HookControllerEntry> {
    const descriptor = buildHookTrustDescriptor(hook);
    const capability = getHookEventCapability(hook.eventName);
    const trusted =
      hook.source.type === "runtime" ||
      hook.source.type === "managed" ||
      (await this.options.trustStore.has(descriptor));

    return {
      capability: descriptor.capability,
      enabled: !this.disabledHookIds.has(hook.hookId),
      eventName: hook.eventName,
      executorType: hook.handler.type,
      handlerHash: descriptor.handlerHash,
      hookId: hook.hookId,
      jsonPointer: hook.jsonPointer,
      opaque: descriptor.opaque,
      runtimeSupported: capability.runtimeSupported,
      ...(hook.source.componentId !== undefined
        ? { sourceComponentId: hook.source.componentId }
        : {}),
      ...(hook.source.path !== undefined ? { sourcePath: hook.source.path } : {}),
      sourceType: hook.source.type,
      ...(hook.handler.statusMessage !== undefined
        ? { statusMessage: hook.handler.statusMessage }
        : {}),
      trustKey: createTrustKey(descriptor),
      trusted,
    };
  }

  private emitStatusMessage(): void {
    this.statusMessageHandler?.([...this.activeStatusMessages.values()].at(-1));
  }
}

export function describeHookTrust(descriptor: HookTrustDescriptor): string {
  return [
    descriptor.capability,
    `source=${descriptor.source.type}`,
    `executor=${descriptor.executorType}`,
    `hash=${descriptor.handlerHash.slice(0, 12)}`,
  ].join(" ");
}
