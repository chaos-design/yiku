import { getHookEventCapability } from "../compatibility/manifest.js";
import type { HookDiagnostic, HookEvent, HookEventName } from "../types.js";
import type { CompiledHook, HookConfigSnapshotView } from "./types.js";

export class HookConfigSnapshot implements HookConfigSnapshotView {
  public readonly diagnostics: readonly HookDiagnostic[];
  public readonly hooks: readonly CompiledHook[];
  public readonly version: string;
  private readonly hooksByEvent: Readonly<Partial<Record<HookEventName, readonly CompiledHook[]>>>;

  public constructor(input: {
    readonly diagnostics: HookConfigSnapshotView["diagnostics"];
    readonly hooks: readonly CompiledHook[];
    readonly version: string;
  }) {
    this.diagnostics = Object.freeze([...input.diagnostics]);
    this.hooks = Object.freeze([...input.hooks]);
    this.version = input.version;
    this.hooksByEvent = groupHooks(this.hooks);
    Object.freeze(this);
  }

  public forEvent(eventName: HookEventName): readonly CompiledHook[] {
    return this.hooksByEvent[eventName] ?? [];
  }

  public matches(event: HookEvent): readonly CompiledHook[] {
    const capability = getHookEventCapability(event.hook_event_name);
    const matcherValue = capability.matcherField
      ? readMatcherValue(event, capability.matcherField)
      : undefined;

    return this.forEvent(event.hook_event_name).filter((hook) => {
      if (matcherValue !== undefined && !hook.matcher.matches(matcherValue)) {
        return false;
      }

      if (hook.condition === undefined) {
        return true;
      }

      if (!("tool_name" in event) || !("tool_input" in event)) {
        return false;
      }

      return hook.condition.matches(event.tool_name, event.tool_input);
    });
  }
}

function groupHooks(
  hooks: readonly CompiledHook[],
): Readonly<Partial<Record<HookEventName, readonly CompiledHook[]>>> {
  const grouped: Partial<Record<HookEventName, CompiledHook[]>> = {};
  const frozen: Partial<Record<HookEventName, readonly CompiledHook[]>> = {};

  for (const hook of hooks) {
    const eventHooks = grouped[hook.eventName] ?? [];
    eventHooks.push(hook);
    grouped[hook.eventName] = eventHooks;
  }

  for (const [eventName, eventHooks] of Object.entries(grouped)) {
    frozen[eventName as HookEventName] = Object.freeze(eventHooks);
  }

  return Object.freeze(frozen);
}

function readMatcherValue(event: HookEvent, field: string): string {
  const value = (event as unknown as Record<string, unknown>)[field];

  return typeof value === "string" ? value : "";
}
