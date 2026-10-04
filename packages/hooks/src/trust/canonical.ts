import { createHash } from "node:crypto";
import type { HookExecutorType, HookSource } from "../types.js";

export interface HookTrustDescriptor {
  readonly capability: string;
  readonly executorType: HookExecutorType;
  readonly handlerHash: string;
  readonly hookId: string;
  readonly opaque: boolean;
  readonly projectPath?: string | undefined;
  readonly scriptHashes?: Readonly<Record<string, string>> | undefined;
  readonly source: HookSource;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createTrustKey(descriptor: HookTrustDescriptor): string {
  return `trust_${sha256(canonicalJson(descriptor)).slice(0, 32)}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
