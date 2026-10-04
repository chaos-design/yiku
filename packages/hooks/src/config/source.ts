import type { HookSource, HookSourceType } from "../types.js";

export const HOOK_SOURCE_PRIORITIES = Object.freeze({
  managed: 700,
  user: 600,
  project: 500,
  local: 400,
  plugin: 300,
  skill: 200,
  agent: 200,
  runtime: 100,
} satisfies Readonly<Record<HookSourceType, number>>);

export function hookSource(
  type: HookSourceType,
  options: {
    readonly componentId?: string | undefined;
    readonly path?: string | undefined;
  } = {},
): HookSource {
  return Object.freeze({
    ...(options.componentId !== undefined ? { componentId: options.componentId } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    priority: HOOK_SOURCE_PRIORITIES[type],
    type,
  });
}

export function compareHookSources(left: HookSource, right: HookSource): number {
  const priority = right.priority - left.priority;

  if (priority !== 0) {
    return priority;
  }

  return sourceKey(left).localeCompare(sourceKey(right));
}

function sourceKey(source: HookSource): string {
  return `${source.type}\0${source.path ?? ""}\0${source.componentId ?? ""}`;
}
