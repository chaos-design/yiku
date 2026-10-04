import { randomUUID } from "node:crypto";
import { getHookEventCapability } from "./compatibility/manifest.js";
import type { CompiledHook, HookConfigSnapshotView } from "./config/types.js";
import { type HookDecisionInput, HookDecisionPolicy } from "./decision.js";
import { asHookError, HookTrustError } from "./errors.js";
import { type HookEventHandler, HookEvents } from "./events.js";
import { HookExecutorRegistry } from "./executors/registry.js";
import { HookScheduler } from "./scheduler.js";
import { HookLimits, type HookResourceLimits } from "./security/limits.js";
import { canonicalJson, type HookTrustDescriptor, sha256 } from "./trust/canonical.js";
import type { HookTrustPolicy } from "./trust/policy.js";
import type {
  HookDecision,
  HookEvent,
  HookEventName,
  HookExecutionResult,
  HookHandler,
  HookInvocation,
} from "./types.js";

export interface HookDispatchState {
  readonly depth: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly parentInvocationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  enqueueBackground(task: Promise<HookDecisionInput>): void;
  hasRunOnce(hookId: string): boolean;
  markOnce(hookId: string): void;
}

export interface HookEngineOptions {
  readonly clock?: (() => Date) | undefined;
  readonly decisionPolicy?: HookDecisionPolicy | undefined;
  readonly executors?: HookExecutorRegistry | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly limits?: HookLimits | Partial<HookResourceLimits> | undefined;
  readonly onEvent?: HookEventHandler | undefined;
  readonly scheduler?: HookScheduler | undefined;
  readonly snapshot: HookConfigSnapshotView;
  readonly trustPolicy?: HookTrustPolicy | undefined;
}

export class HookEngine {
  public readonly limits: HookLimits;
  private readonly clock: () => Date;
  private readonly decisionPolicy: HookDecisionPolicy;
  private readonly events: HookEvents;
  private readonly executors: HookExecutorRegistry;
  private readonly idGenerator: () => string;
  private readonly scheduler: HookScheduler;
  private snapshot: HookConfigSnapshotView;
  private readonly trustPolicy?: HookTrustPolicy | undefined;

  public constructor(options: HookEngineOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.decisionPolicy = options.decisionPolicy ?? new HookDecisionPolicy();
    this.events = new HookEvents(options.onEvent);
    this.executors = options.executors ?? new HookExecutorRegistry();
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.limits =
      options.limits instanceof HookLimits ? options.limits : new HookLimits(options.limits);
    this.scheduler = options.scheduler ?? new HookScheduler();
    this.snapshot = options.snapshot;
    this.trustPolicy = options.trustPolicy;
  }

  public currentSnapshot(): HookConfigSnapshotView {
    return this.snapshot;
  }

  public replaceSnapshot(snapshot: HookConfigSnapshotView): void {
    this.snapshot = snapshot;
  }

  public aggregate(inputs: readonly HookDecisionInput[]): HookDecision {
    return this.decisionPolicy.aggregate(inputs);
  }

  public async dispatch(event: HookEvent, state: HookDispatchState): Promise<HookDecision> {
    const startedAt = this.clock();
    const operationId = this.idGenerator();
    const capability = getHookEventCapability(event.hook_event_name);

    this.events.emit({
      eventName: event.hook_event_name,
      operation: "dispatch",
      operationId,
      phase: "start",
      startedAt: startedAt.toISOString(),
    });

    if (!capability.runtimeSupported) {
      const decision = unavailableDecision(event.hook_event_name);
      this.finishDispatch(operationId, startedAt, decision);
      return decision;
    }

    try {
      const snapshot = this.snapshot;
      const hooks = snapshot
        .matches(event)
        .filter((hook) => !(hook.handler.once === true && state.hasRunOnce(hook.hookId)));

      await this.authorize(hooks, event.hook_event_name);

      const deadline = startedAt.getTime() + this.limits.eventTimeoutMs;
      const scheduled = await this.scheduler.run(
        hooks,
        async (hook, _index, signal) => {
          if (hook.handler.type === "command" && hook.handler.async === true) {
            const task = this.execute(hook, event, state, state.signal, deadline).then((input) => {
              if (input.result.status === "success" && hook.handler.once === true) {
                state.markOnce(hook.hookId);
              }
              return input;
            });
            state.enqueueBackground(task);
            return {
              hook,
              result: backgroundResult(this.clock()),
            } satisfies HookDecisionInput;
          }

          const input = await this.execute(hook, event, state, signal, deadline);
          if (input.result.status === "success" && hook.handler.once === true) {
            state.markOnce(hook.hookId);
          }
          return input;
        },
        {
          deadline,
          maxConcurrency: this.limits.maxConcurrentHandlers,
          signal: state.signal,
        },
      );
      const inputs = scheduled.map((result, index): HookDecisionInput => {
        if (result.status === "fulfilled") {
          return result.value;
        }

        const hook = hooks[index];
        if (hook === undefined) {
          throw result.reason;
        }

        return {
          hook,
          result: failedResult(result.reason, startedAt, this.clock()),
        };
      });
      const decision = this.decisionPolicy.aggregate(inputs);
      this.finishDispatch(operationId, startedAt, decision);
      return decision;
    } catch (error) {
      const hookError = asHookError(
        error,
        "HOOK_EXECUTION_FAILED",
        `Hook dispatch failed for ${event.hook_event_name}.`,
        { eventName: event.hook_event_name },
      );
      this.events.emit({
        code: hookError.code,
        durationMs: this.clock().getTime() - startedAt.getTime(),
        endedAt: this.clock().toISOString(),
        eventName: event.hook_event_name,
        operation: "dispatch",
        operationId,
        phase: "error",
        startedAt: startedAt.toISOString(),
      });
      throw hookError;
    }
  }

  private async authorize(hooks: readonly CompiledHook[], eventName: HookEventName): Promise<void> {
    for (const hook of hooks) {
      if (hook.handler.type === "callback" && hook.source.type === "runtime") {
        continue;
      }

      if (this.trustPolicy === undefined) {
        throw new HookTrustError(
          "HOOK_TRUST_REQUIRED",
          "Hook requires a configured trust policy.",
          {
            executorType: hook.handler.type,
            hookId: hook.hookId,
            sourceType: hook.source.type,
          },
        );
      }

      await this.trustPolicy.authorize(buildHookTrustDescriptor(hook), eventName);
    }
  }

  private async execute(
    hook: CompiledHook,
    event: HookEvent,
    state: HookDispatchState,
    signal: AbortSignal | undefined,
    eventDeadline: number,
  ): Promise<HookDecisionInput> {
    const startedAt = this.clock();
    const invocationId = this.idGenerator();
    const invocation: HookInvocation = {
      event,
      handler: hook.handler,
      hookId: hook.hookId,
      invocationId,
      ...(state.parentInvocationId !== undefined
        ? { parentInvocationId: state.parentInvocationId }
        : {}),
      source: hook.source,
    };
    this.events.emit({
      eventName: event.hook_event_name,
      executorType: hook.handler.type,
      hookId: hook.hookId,
      invocationId,
      operation: "execute",
      operationId: invocationId,
      ...(state.parentInvocationId !== undefined
        ? { parentInvocationId: state.parentInvocationId }
        : {}),
      phase: "start",
      sourceType: hook.source.type,
      startedAt: startedAt.toISOString(),
    });

    try {
      const timeoutMs = (hook.handler.timeout ?? this.defaultTimeoutSeconds(hook.handler)) * 1_000;
      const result = await this.executors.get(hook.handler.type).execute(invocation, hook.handler, {
        deadline: Math.min(eventDeadline, startedAt.getTime() + timeoutMs),
        depth: state.depth,
        environment: state.environment,
        ...(signal !== undefined ? { signal } : {}),
      });
      this.events.emit({
        durationMs: result.durationMs,
        endedAt: result.endedAt,
        eventName: event.hook_event_name,
        executorType: hook.handler.type,
        hookId: hook.hookId,
        invocationId,
        operation: "execute",
        operationId: invocationId,
        outcome: result.status,
        phase: result.status === "success" || result.status === "background" ? "end" : "error",
        sourceType: hook.source.type,
        startedAt: result.startedAt,
        ...((result.truncatedStderrBytes ?? 0) + (result.truncatedStdoutBytes ?? 0) > 0
          ? {
              truncatedBytes:
                (result.truncatedStderrBytes ?? 0) + (result.truncatedStdoutBytes ?? 0),
            }
          : {}),
      });
      return { hook, result };
    } catch (error) {
      const result = failedResult(error, startedAt, this.clock());
      this.events.emit({
        code: result.errorCode,
        durationMs: result.durationMs,
        endedAt: result.endedAt,
        eventName: event.hook_event_name,
        executorType: hook.handler.type,
        hookId: hook.hookId,
        invocationId,
        operation: "execute",
        operationId: invocationId,
        outcome: result.status,
        phase: "error",
        sourceType: hook.source.type,
        startedAt: result.startedAt,
      });
      return { hook, result };
    }
  }

  private defaultTimeoutSeconds(handler: HookHandler): number {
    switch (handler.type) {
      case "agent":
        return this.limits.defaultAgentTimeoutMs / 1_000;
      case "command":
        return this.limits.defaultCommandTimeoutMs / 1_000;
      case "http":
      case "mcp":
        return this.limits.defaultHttpTimeoutMs / 1_000;
      case "prompt":
      case "callback":
        return this.limits.defaultPromptTimeoutMs / 1_000;
    }
  }

  private finishDispatch(operationId: string, startedAt: Date, decision: HookDecision): void {
    const endedAt = this.clock();
    this.events.emit({
      counts: {
        diagnostics: decision.diagnostics.length,
      },
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt: endedAt.toISOString(),
      operation: "dispatch",
      operationId,
      phase: "end",
      startedAt: startedAt.toISOString(),
    });
  }
}

export function buildHookTrustDescriptor(hook: CompiledHook): HookTrustDescriptor {
  const handler = trustHandler(hook.handler);
  return {
    capability: capabilitySummary(hook.handler),
    executorType: hook.handler.type,
    handlerHash: sha256(canonicalJson(handler)),
    hookId: hook.hookId,
    opaque: hook.handler.type === "command",
    source: hook.source,
  };
}

function trustHandler(handler: HookHandler): unknown {
  if (handler.type !== "callback") {
    return handler;
  }

  return {
    name: handler.name,
    type: handler.type,
  };
}

function capabilitySummary(handler: HookHandler): string {
  switch (handler.type) {
    case "agent":
    case "prompt":
      return `${handler.type}:${handler.model ?? "default"}`;
    case "callback":
      return `callback:${handler.name}`;
    case "command":
      return `command:${handler.shell ?? "default"}:${handler.command}:env=inherited`;
    case "http":
      return `http:${new URL(handler.url).origin}:env=${[...(handler.allowedEnvVars ?? [])]
        .sort()
        .join(",")}`;
    case "mcp":
      return `mcp:${handler.server}:${handler.tool}`;
  }
}

function backgroundResult(now: Date): HookExecutionResult {
  const timestamp = now.toISOString();
  return {
    durationMs: 0,
    endedAt: timestamp,
    startedAt: timestamp,
    status: "background",
  };
}

function failedResult(error: unknown, startedAt: Date, endedAt: Date): HookExecutionResult {
  const hookError = asHookError(error, "HOOK_EXECUTION_FAILED", "Hook execution failed.");
  return {
    durationMs: endedAt.getTime() - startedAt.getTime(),
    endedAt: endedAt.toISOString(),
    errorCode: hookError.code,
    startedAt: startedAt.toISOString(),
    status:
      hookError.code === "HOOK_TIMEOUT"
        ? "timeout"
        : hookError.code === "HOOK_ABORTED"
          ? "aborted"
          : "error",
  };
}

function unavailableDecision(eventName: HookEvent["hook_event_name"]): HookDecision {
  const decision: HookDecision = {
    action: "no-op",
    additionalContext: Object.freeze([]),
    diagnostics: Object.freeze([
      {
        code: "HOOK_CAPABILITY_UNAVAILABLE",
        message: `${eventName} Runtime capability is deferred.`,
        severity: "warning" as const,
      },
    ]),
    permissionUpdates: Object.freeze([]),
    reasons: Object.freeze([]),
    suppressOutput: false,
    systemMessages: Object.freeze([]),
  };
  return Object.freeze(decision);
}
