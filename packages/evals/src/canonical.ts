import { createHash } from "node:crypto";
import { type EvalErrorCode, EvaluationError } from "./errors.js";

type CanonicalValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export interface CanonicalOptions {
  readonly code?: EvalErrorCode | undefined;
  readonly label?: string | undefined;
}

export function canonicalStringify(value: unknown, options: CanonicalOptions = {}): string {
  const normalized = canonicalize(value, new WeakSet<object>(), options, "$");
  return JSON.stringify(normalized);
}

export function sha256Digest(value: unknown, options: CanonicalOptions = {}): string {
  return createHash("sha256").update(canonicalStringify(value, options)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalize(
  value: unknown,
  ancestors: WeakSet<object>,
  options: CanonicalOptions,
  path: string,
): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidCanonicalValue(options, path, "must be a finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return withAncestor(value, ancestors, options, path, () =>
      value.map((item, index) => canonicalize(item, ancestors, options, `${path}[${index}]`)),
    );
  }
  if (typeof value !== "object") {
    throw invalidCanonicalValue(options, path, `contains unsupported ${typeof value}`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidCanonicalValue(options, path, "must contain only plain objects");
  }

  return withAncestor(value, ancestors, options, path, () => {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw invalidCanonicalValue(options, path, "must not contain symbol keys");
    }

    const result: Record<string, CanonicalValue> = {};
    for (const key of (keys as string[]).toSorted((left, right) => left.localeCompare(right))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw invalidCanonicalValue(options, `${path}.${key}`, "must be an enumerable data field");
      }
      result[key] = canonicalize(descriptor.value, ancestors, options, `${path}.${key}`);
    }
    return result;
  });
}

function withAncestor<TValue>(
  value: object,
  ancestors: WeakSet<object>,
  options: CanonicalOptions,
  path: string,
  operation: () => TValue,
): TValue {
  if (ancestors.has(value)) {
    throw invalidCanonicalValue(options, path, "must not contain circular references");
  }
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function invalidCanonicalValue(
  options: CanonicalOptions,
  path: string,
  reason: string,
): EvaluationError {
  return new EvaluationError(
    options.code ?? "EVAL_INVALID_RESULT",
    `${options.label ?? "Canonical value"} at ${path} ${reason}.`,
  );
}
