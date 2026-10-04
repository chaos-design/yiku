import type { HookOperationEvent } from "@yiku/hooks";
import type { HookControllerEntry, HookDryRunResult } from "./controller.js";

export function presentHookList(entries: readonly HookControllerEntry[]): string {
  if (entries.length === 0) {
    return "No Hooks are configured.\nUse /hooks for command help.";
  }

  const lines = entries.map(
    (entry) =>
      `${entry.hookId}  ${entry.eventName}  ${entry.executorType}  ${entry.sourceType}  ${
        entry.enabled ? "enabled" : "disabled"
      }  ${entry.trusted ? "trusted" : "untrusted"}`,
  );
  return [`Hooks (${entries.length})`, ...lines].join("\n");
}

export function presentHookInspection(entry: HookControllerEntry): string {
  return [
    `Hook: ${entry.hookId}`,
    `Event: ${entry.eventName}`,
    `Executor: ${entry.executorType}`,
    `Source: ${entry.sourceType}${entry.sourcePath ? ` (${entry.sourcePath})` : ""}`,
    `Capability: ${entry.capability}`,
    `Enabled: ${entry.enabled ? "yes" : "no"}`,
    `Trusted: ${entry.trusted ? "yes" : "no"}`,
    `Runtime supported: ${entry.runtimeSupported ? "yes" : "no"}`,
    `Opaque shell: ${entry.opaque ? "yes" : "no"}`,
    `Handler hash: ${entry.handlerHash}`,
    `Trust key: ${entry.trustKey}`,
    `Config pointer: ${entry.jsonPointer}`,
  ].join("\n");
}

export function presentHookDryRun(result: HookDryRunResult): string {
  return [
    `Dry run: ${result.entry.hookId}`,
    `Executable: ${result.executable ? "yes" : "no"}`,
    result.message,
  ].join("\n");
}

export function presentRecentHookEvents(events: readonly HookOperationEvent[]): string {
  if (events.length === 0) {
    return "No recent Hook operations.";
  }

  return [
    `Recent Hook operations (${events.length})`,
    ...events.map((event) => {
      const target = event.hookId ?? event.eventName ?? "engine";
      const outcome = event.outcome ?? event.code ?? event.phase;
      const duration = event.durationMs === undefined ? "" : ` ${event.durationMs}ms`;
      return `${event.startedAt}  ${event.operation}/${event.phase}  ${target}  ${outcome}${duration}`;
    }),
  ].join("\n");
}

export const HOOKS_USAGE = [
  "Hook commands:",
  "/hooks list",
  "/hooks inspect <hookId>",
  "/hooks trust <hookId>",
  "/hooks revoke <hookId>",
  "/hooks enable <hookId>",
  "/hooks disable <hookId>",
  "/hooks dry-run <hookId>",
  "/hooks recent",
].join("\n");
