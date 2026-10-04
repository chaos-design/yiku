import type { EnvVars } from "./env.js";
import type { ModelsConfig } from "./models.js";

export function mergeConfig(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): ModelsConfig {
  const merged: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const baseValue = base[key];
    const overrideValue = override[key];
    merged[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeConfig(baseValue, overrideValue)
        : cloneValue(overrideValue === undefined ? baseValue : overrideValue);
  }

  return merged;
}

export function mergeEnv(...sources: readonly EnvVars[]): EnvVars {
  return Object.assign({}, ...sources);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isRecord(value)) {
    return mergeConfig({}, value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
