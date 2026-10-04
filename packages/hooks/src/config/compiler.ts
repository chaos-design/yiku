import { parseHookHandler } from "../compatibility/handler-schema.js";
import { getHookEventCapability } from "../compatibility/manifest.js";
import { HookConfigError } from "../errors.js";
import { HookCondition } from "../matching/condition.js";
import { HookMatcher } from "../matching/matcher.js";
import { canonicalJson, sha256 } from "../trust/canonical.js";
import {
  HOOK_EVENT_NAMES,
  type HookDiagnostic,
  type HookEventName,
  type HookHandler,
  type HookSource,
} from "../types.js";
import { HookConfigSnapshot } from "./snapshot.js";
import { compareHookSources } from "./source.js";
import type {
  CompiledHook,
  HookConfigCompilation,
  HookConfigDocument,
  HookMatcherGroupConfig,
} from "./types.js";

const EVENT_NAMES = new Set<string>(HOOK_EVENT_NAMES);

export class HookConfigCompiler {
  public compile(documents: readonly HookConfigDocument[]): HookConfigCompilation {
    const hooks: CompiledHook[] = [];
    const diagnostics: HookDiagnostic[] = [];
    const orderedDocuments = [...documents].sort((left, right) =>
      compareHookSources(left.source, right.source),
    );

    for (const document of orderedDocuments) {
      this.compileDocument(document, hooks, diagnostics);
    }

    const snapshot = new HookConfigSnapshot({
      diagnostics,
      hooks,
      version: sha256(hooks.map((hook) => hook.hookId).join("\n")),
    });

    return {
      diagnostics: snapshot.diagnostics,
      snapshot,
    };
  }

  private compileDocument(
    document: HookConfigDocument,
    hooks: CompiledHook[],
    diagnostics: HookDiagnostic[],
  ): void {
    const settings = requireRecord(document.value, document.source, "Hook settings");
    const rawHooks = settings.hooks;

    if (rawHooks === undefined) {
      return;
    }

    const hooksByEvent = requireRecord(rawHooks, document.source, "Hook settings hooks");

    for (const [rawEventName, rawGroups] of Object.entries(hooksByEvent)) {
      if (!EVENT_NAMES.has(rawEventName)) {
        throw configError(document.source, `Unsupported Hook event: ${rawEventName}.`);
      }

      const eventName = rawEventName as HookEventName;
      const groups = requireArray(rawGroups, document.source, `${eventName} matcher groups`);

      for (const [groupIndex, rawGroup] of groups.entries()) {
        const pointer = `/hooks/${escapePointer(eventName)}/${groupIndex}`;
        const group = parseMatcherGroup(rawGroup, document.source, pointer);
        const capability = getHookEventCapability(eventName);
        const matcher =
          capability.matcherField === undefined && group.matcher
            ? ignoredMatcher(eventName, group.matcher, pointer, diagnostics)
            : new HookMatcher(group.matcher);

        for (const [handlerIndex, rawHandler] of group.hooks.entries()) {
          const handlerPointer = `${pointer}/hooks/${handlerIndex}`;
          const handler = parseConfiguredHandler(rawHandler, document.source, handlerPointer);

          if (!capability.handlers.includes(handler.type)) {
            throw configError(
              document.source,
              `${handler.type} handlers are not supported for ${eventName}.`,
            );
          }

          const condition = handler.if ? new HookCondition(handler.if) : undefined;
          const hookId = createHookId({
            eventName,
            handler,
            jsonPointer: handlerPointer,
            source: document.source,
          });

          hooks.push(
            Object.freeze({
              ...(condition !== undefined ? { condition } : {}),
              eventName,
              handler: freezeHandler(handler),
              hookId,
              jsonPointer: handlerPointer,
              matcher,
              source: document.source,
            }),
          );
        }
      }
    }
  }
}

function parseMatcherGroup(
  value: unknown,
  source: HookSource,
  pointer: string,
): HookMatcherGroupConfig {
  const group = requireRecord(value, source, `Hook matcher group ${pointer}`);
  const unknownKeys = Object.keys(group).filter((key) => key !== "hooks" && key !== "matcher");

  if (unknownKeys.length > 0) {
    throw configError(source, `Unknown Hook matcher group field at ${pointer}: ${unknownKeys[0]}.`);
  }

  if (group.matcher !== undefined && typeof group.matcher !== "string") {
    throw configError(source, `Hook matcher at ${pointer}/matcher must be a string.`);
  }

  return {
    hooks: requireArray(group.hooks, source, `Hook handlers at ${pointer}/hooks`) as HookHandler[],
    ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
  };
}

function parseConfiguredHandler(value: unknown, source: HookSource, pointer: string): HookHandler {
  if (
    source.type === "runtime" &&
    isRecord(value) &&
    value.type === "callback" &&
    typeof value.callback === "function" &&
    typeof value.name === "string"
  ) {
    return value as unknown as HookHandler;
  }

  try {
    return parseHookHandler(value);
  } catch (error) {
    throw new HookConfigError("HOOK_CONFIG_INVALID", `Hook handler at ${pointer} is invalid.`, {
      cause: error,
      sourceType: source.type,
    });
  }
}

function ignoredMatcher(
  eventName: HookEventName,
  matcher: string,
  pointer: string,
  diagnostics: HookDiagnostic[],
): HookMatcher {
  diagnostics.push({
    code: "HOOK_MATCHER_IGNORED",
    message: `${eventName} does not support matcher ${JSON.stringify(matcher)} at ${pointer}.`,
    severity: "warning",
  });
  return new HookMatcher();
}

function createHookId(input: {
  readonly eventName: HookEventName;
  readonly handler: HookHandler;
  readonly jsonPointer: string;
  readonly source: HookSource;
}): string {
  const handler =
    input.handler.type === "callback"
      ? {
          if: input.handler.if,
          name: input.handler.name,
          once: input.handler.once,
          timeout: input.handler.timeout,
          type: input.handler.type,
        }
      : input.handler;
  const canonical = canonicalJson({
    componentId: input.source.componentId,
    eventName: input.eventName,
    handler,
    jsonPointer: input.jsonPointer,
    path: input.source.path,
    sourceType: input.source.type,
  });

  return `hook_${sha256(canonical).slice(0, 24)}`;
}

function freezeHandler<T extends HookHandler>(handler: T): T {
  return deepFreeze(handler);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function requireRecord(value: unknown, source: HookSource, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw configError(source, `${name} must be an object.`);
  }

  return value;
}

function requireArray(value: unknown, source: HookSource, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw configError(source, `${name} must be an array.`);
  }

  return value;
}

function configError(source: HookSource, message: string): HookConfigError {
  return new HookConfigError("HOOK_CONFIG_INVALID", message, {
    sourceType: source.type,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
