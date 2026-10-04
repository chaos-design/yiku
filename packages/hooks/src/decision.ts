import type { CompiledHook } from "./config/types.js";
import { HookDecisionConflictError } from "./errors.js";
import { canonicalJson } from "./trust/canonical.js";
import type {
  HookAction,
  HookDecision,
  HookDiagnostic,
  HookExecutionResult,
  HookHandlerOutput,
  HookPermissionUpdate,
  JsonObject,
  JsonValue,
} from "./types.js";

export interface HookDecisionInput {
  readonly hook: CompiledHook;
  readonly result: HookExecutionResult;
}

const ACTION_STRENGTH: Readonly<Record<HookAction, number>> = Object.freeze({
  allow: 1,
  block: 3,
  defer: 2,
  "no-op": 0,
  stop: 4,
});

export class HookDecisionPolicy {
  public aggregate(inputs: readonly HookDecisionInput[]): HookDecision {
    let action: HookAction = "no-op";
    const additionalContext: string[] = [];
    const diagnostics: HookDiagnostic[] = [];
    const permissionUpdates: HookPermissionUpdate[] = [];
    const reasons: string[] = [];
    const systemMessages: string[] = [];
    let suppressOutput = false;
    let updatedInput: Record<string, JsonValue> | undefined;
    let updatedValue: JsonValue | undefined;

    for (const input of inputs) {
      const { hook, result } = input;

      if (result.status !== "success") {
        diagnostics.push(executionDiagnostic(hook, result));
        continue;
      }

      const output = result.output;
      if (output === undefined) {
        continue;
      }

      action = strongest(action, outputAction(output));
      appendUnique(additionalContext, output.additionalContext);
      appendUnique(additionalContext, output.hookSpecificOutput?.additionalContext);
      appendUnique(systemMessages, output.systemMessage);
      appendUnique(reasons, output.reason);
      appendUnique(reasons, output.stopReason);
      permissionUpdates.push(...(output.permissionUpdates ?? []));
      const permissionDecision = output.hookSpecificOutput?.permissionDecision;
      if (permissionDecision !== undefined) {
        permissionUpdates.push({
          decision: permissionDecision,
        });
      }
      suppressOutput ||= output.suppressOutput === true;
      updatedInput = mergeUpdatedInput(updatedInput, output.updatedInput, hook.hookId);
      updatedInput = mergeUpdatedInput(
        updatedInput,
        output.hookSpecificOutput?.updatedInput,
        hook.hookId,
      );
      const incomingValue = output.hookSpecificOutput?.updatedValue;
      if (incomingValue !== undefined) {
        if (
          updatedValue !== undefined &&
          canonicalJson(updatedValue) !== canonicalJson(incomingValue)
        ) {
          throw new HookDecisionConflictError(
            "HOOK_DECISION_CONFLICT",
            "Hook scalar output updates conflict.",
            { hookId: hook.hookId },
          );
        }
        updatedValue = incomingValue;
      }
    }

    return Object.freeze({
      action,
      additionalContext: Object.freeze(additionalContext),
      diagnostics: Object.freeze(diagnostics),
      permissionUpdates: Object.freeze(permissionUpdates),
      reasons: Object.freeze(reasons),
      suppressOutput,
      systemMessages: Object.freeze(systemMessages),
      ...(updatedInput !== undefined ? { updatedInput: Object.freeze(updatedInput) } : {}),
      ...(updatedValue !== undefined ? { updatedValue } : {}),
    });
  }
}

function outputAction(output: HookHandlerOutput): HookAction {
  if (output.continue === false || output.action === "stop") {
    return "stop";
  }

  if (
    output.action === "block" ||
    output.decision === "block" ||
    output.hookSpecificOutput?.permissionDecision === "deny"
  ) {
    return "block";
  }

  if (output.action === "defer") {
    return "defer";
  }

  if (
    output.action === "allow" ||
    output.decision === "allow" ||
    output.hookSpecificOutput?.permissionDecision === "allow"
  ) {
    return "allow";
  }

  return "no-op";
}

function strongest(current: HookAction, candidate: HookAction): HookAction {
  return ACTION_STRENGTH[candidate] > ACTION_STRENGTH[current] ? candidate : current;
}

function appendUnique(target: string[], value: string | readonly string[] | undefined): void {
  if (value === undefined) {
    return;
  }

  const values = typeof value === "string" ? [value] : value;
  for (const item of values) {
    const normalized = item.trim();
    if (normalized && !target.includes(normalized)) {
      target.push(normalized);
    }
  }
}

function mergeUpdatedInput(
  current: Record<string, JsonValue> | undefined,
  incoming: JsonObject | undefined,
  hookId: string,
): Record<string, JsonValue> | undefined {
  if (incoming === undefined) {
    return current;
  }

  const merged = current ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    const previous = merged[key];

    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(value)) {
      throw new HookDecisionConflictError(
        "HOOK_DECISION_CONFLICT",
        `Hook input update conflicts at field ${key}.`,
        { hookId },
      );
    }

    merged[key] = value;
  }

  return merged;
}

function executionDiagnostic(hook: CompiledHook, result: HookExecutionResult): HookDiagnostic {
  return {
    code: result.errorCode ?? `HOOK_EXECUTION_${result.status.toUpperCase()}`,
    hookId: hook.hookId,
    message: `Hook ${hook.hookId} finished with status ${result.status}.`,
    severity: "error",
  };
}
