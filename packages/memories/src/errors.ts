import type { MemoryOperation } from "./types.js";

export type MemoryErrorCode =
  | "MEMORY_ABORTED"
  | "MEMORY_EMBEDDING_FAILED"
  | "MEMORY_EMBEDDING_INVALID"
  | "MEMORY_EXTRACTION_FAILED"
  | "MEMORY_EXTRACTION_NOT_CONFIGURED"
  | "MEMORY_IDEMPOTENCY_CONFLICT"
  | "MEMORY_INVALID_CONTENT"
  | "MEMORY_INVALID_CONTEXT"
  | "MEMORY_INVALID_DATE"
  | "MEMORY_INVALID_METADATA"
  | "MEMORY_INVALID_NUMBER"
  | "MEMORY_INVALID_QUERY"
  | "MEMORY_INVALID_TAGS"
  | "MEMORY_MANAGER_CLOSED"
  | "MEMORY_MIGRATION_FAILED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_REDACTION_FAILED"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_SCHEMA_NEWER_THAN_RUNTIME"
  | "MEMORY_STORE_CLOSED"
  | "MEMORY_STORE_UNAVAILABLE";

export interface MemoryErrorOptions {
  readonly cause?: unknown;
  readonly operation?: MemoryOperation | undefined;
}

export class MemoryError extends Error {
  public readonly code: MemoryErrorCode;
  public readonly operation: MemoryOperation | undefined;

  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MemoryError";
    this.code = code;
    this.operation = options.operation;
  }
}

export class MemoryValidationError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryValidationError";
  }
}

export class MemoryConflictError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryConflictError";
  }
}

export class MemoryStoreError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryStoreError";
  }
}

export class MemoryExtractionError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryExtractionError";
  }
}

export class MemoryEmbeddingError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryEmbeddingError";
  }
}

export class MemoryMigrationError extends MemoryError {
  public constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(code, message, options);
    this.name = "MemoryMigrationError";
  }
}

export class MemoryAbortError extends MemoryError {
  public constructor(operation?: MemoryOperation) {
    super("MEMORY_ABORTED", "Memory operation was aborted.", { operation });
    this.name = "MemoryAbortError";
  }
}

export function asMemoryError(
  error: unknown,
  operation: MemoryOperation,
  fallbackMessage: string,
): MemoryError {
  if (error instanceof MemoryError) {
    return error;
  }

  return new MemoryStoreError("MEMORY_STORE_UNAVAILABLE", fallbackMessage, {
    cause: error,
    operation,
  });
}

export function throwIfAborted(signal: AbortSignal | undefined, operation?: MemoryOperation): void {
  if (signal?.aborted) {
    throw new MemoryAbortError(operation);
  }
}
