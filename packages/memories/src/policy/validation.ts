import { createHash } from "node:crypto";
import { type MemoryErrorCode, MemoryValidationError } from "../errors.js";
import type {
  JsonValue,
  MemoryContext,
  MemoryKind,
  MemoryPolicy,
  MemoryScope,
  MemorySource,
} from "../types.js";

const MEMORY_KINDS = new Set<MemoryKind>([
  "decision",
  "episode",
  "fact",
  "preference",
  "procedure",
]);
const SOURCE_TYPES = new Set(["import", "session", "tool", "user"]);

export function validateContext(context: MemoryContext, policy: MemoryPolicy): MemoryContext {
  if (typeof context !== "object" || context === null) {
    throw validationError("MEMORY_INVALID_CONTEXT", "Memory context must be an object.");
  }

  const namespace = validateBoundedText(
    context.namespace,
    policy.namespaceMaxBytes,
    "Memory namespace",
    "MEMORY_INVALID_CONTEXT",
  );
  const scope = validateScope(context.scope === undefined ? {} : context.scope, policy);

  return {
    namespace,
    scope,
  };
}

export function validateScope(scope: MemoryScope, policy: MemoryPolicy): MemoryScope {
  if (typeof scope !== "object" || scope === null) {
    throw validationError("MEMORY_INVALID_CONTEXT", "Memory scope must be an object.");
  }

  return {
    ...normalizeScopeValue("agentId", scope.agentId, policy),
    ...normalizeScopeValue("projectId", scope.projectId, policy),
    ...normalizeScopeValue("sessionId", scope.sessionId, policy),
    ...normalizeScopeValue("userId", scope.userId, policy),
  };
}

export function validateContent(content: string, policy: MemoryPolicy): string {
  return validateBoundedText(
    normalizeStoredText(content),
    policy.maxContentBytes,
    "Memory content",
    "MEMORY_INVALID_CONTENT",
  );
}

export function normalizeContent(content: string): string {
  return normalizeStoredText(content).replace(/[ \t]+/gu, " ");
}

export function validateKind(kind: MemoryKind): MemoryKind {
  if (!MEMORY_KINDS.has(kind)) {
    throw validationError("MEMORY_INVALID_CONTENT", `Unsupported memory kind: ${String(kind)}.`);
  }

  return kind;
}

export function validateScore(value: number | undefined, fallback: number): number {
  const score = value ?? fallback;

  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw validationError(
      "MEMORY_INVALID_NUMBER",
      "Memory confidence and importance must be finite numbers between 0 and 1.",
    );
  }

  return score;
}

export function validatePositiveInteger(value: number, maximum: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw validationError(
      "MEMORY_INVALID_NUMBER",
      `${fieldName} must be a positive integer no greater than ${maximum}.`,
    );
  }

  return value;
}

export function validateDate(value: string, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("MEMORY_INVALID_DATE", `${fieldName} must be a valid date.`);
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw validationError("MEMORY_INVALID_DATE", `${fieldName} must be a valid date.`);
  }

  return date.toISOString();
}

export function validateTags(
  tags: readonly string[] | undefined,
  policy: MemoryPolicy,
): readonly string[] {
  if (tags === undefined) {
    return [];
  }

  if (!Array.isArray(tags) || tags.length > policy.maxTags) {
    throw validationError(
      "MEMORY_INVALID_TAGS",
      `Memory tags must contain no more than ${policy.maxTags} entries.`,
    );
  }

  const normalized = tags.map((tag) =>
    validateBoundedText(tag, policy.maxTagBytes, "Memory tag", "MEMORY_INVALID_TAGS"),
  );

  return [...new Set(normalized)].sort();
}

export function validateMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  policy: MemoryPolicy,
): Readonly<Record<string, JsonValue>> {
  if (metadata === undefined) {
    return {};
  }

  const normalized = normalizeJsonObject(metadata, 0, policy.maxMetadataDepth, new WeakSet());
  const size = Buffer.byteLength(JSON.stringify(normalized), "utf8");

  if (size > policy.maxMetadataBytes) {
    throw validationError(
      "MEMORY_INVALID_METADATA",
      `Memory metadata exceeds ${policy.maxMetadataBytes} UTF-8 bytes.`,
    );
  }

  return normalized as Readonly<Record<string, JsonValue>>;
}

export function validateSource(source: MemorySource | undefined): MemorySource {
  if (source === undefined) {
    return { type: "user" };
  }

  if (!SOURCE_TYPES.has(source.type)) {
    throw validationError("MEMORY_INVALID_CONTENT", "Memory source type is invalid.");
  }

  const id = source.id?.trim();

  return {
    ...(id ? { id } : {}),
    type: source.type,
  };
}

export function createScopeKey(scope: MemoryScope): string {
  return hashCanonical({
    agentId: scope.agentId ?? null,
    projectId: scope.projectId ?? null,
    sessionId: scope.sessionId ?? null,
    userId: scope.userId ?? null,
  });
}

export function createFingerprint(kind: MemoryKind, normalizedContent: string): string {
  return hashCanonical({
    content: normalizedContent,
    kind,
  });
}

export function createIdempotencyHash(value: unknown): string {
  return hashCanonical(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function validateScopeValue(
  value: string | undefined,
  policy: MemoryPolicy,
  name: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return validateBoundedText(
    value,
    policy.maxScopeValueBytes,
    `Memory scope ${name}`,
    "MEMORY_INVALID_CONTEXT",
  );
}

function normalizeScopeValue(
  name: keyof MemoryScope,
  value: string | undefined,
  policy: MemoryPolicy,
): Partial<Record<keyof MemoryScope, string>> {
  const normalized = validateScopeValue(value, policy, name);

  return normalized === undefined ? {} : { [name]: normalized };
}

function validateBoundedText(
  value: string,
  maximumBytes: number,
  fieldName: string,
  code: MemoryErrorCode,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(code, `${fieldName} must be a non-empty string.`);
  }

  const normalized = value.trim();

  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw validationError(code, `${fieldName} exceeds ${maximumBytes} UTF-8 bytes.`);
  }

  return normalized;
}

function normalizeStoredText(value: string): string {
  return typeof value === "string"
    ? value.normalize("NFC").replace(/\r\n?/gu, "\n").trim()
    : (value as string);
}

function normalizeJsonObject(
  value: object,
  depth: number,
  maximumDepth: number,
  seen: WeakSet<object>,
): Readonly<Record<string, JsonValue>> {
  const normalized = normalizeJsonValue(value, depth, maximumDepth, seen);

  if (Array.isArray(normalized) || normalized === null || typeof normalized !== "object") {
    throw validationError("MEMORY_INVALID_METADATA", "Memory metadata must be a JSON object.");
  }

  return normalized as Readonly<Record<string, JsonValue>>;
}

function normalizeJsonValue(
  value: unknown,
  depth: number,
  maximumDepth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError("MEMORY_INVALID_METADATA", "Metadata numbers must be finite.");
    }

    return value;
  }

  if (typeof value !== "object") {
    throw validationError("MEMORY_INVALID_METADATA", "Metadata contains a non-JSON value.");
  }

  if (depth >= maximumDepth) {
    throw validationError("MEMORY_INVALID_METADATA", "Memory metadata is nested too deeply.");
  }

  if (seen.has(value)) {
    throw validationError("MEMORY_INVALID_METADATA", "Memory metadata must not be cyclic.");
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsonValue(item, depth + 1, maximumDepth, seen));
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError(
        "MEMORY_INVALID_METADATA",
        "Memory metadata objects must use a plain prototype.",
      );
    }

    const result: Record<string, JsonValue> = {};

    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw validationError(
          "MEMORY_INVALID_METADATA",
          "Memory metadata must not contain accessors.",
        );
      }

      result[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        maximumDepth,
        seen,
      );
    }

    return result;
  } finally {
    seen.delete(value);
  }
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validationError(code: MemoryErrorCode, message: string): MemoryValidationError {
  return new MemoryValidationError(code, message);
}
