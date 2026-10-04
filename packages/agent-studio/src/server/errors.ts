import type { JsonValue } from "../types.js";

export class StudioError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: JsonValue | undefined,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

export function invalidRequest(message: string, details?: JsonValue): StudioError {
  return new StudioError(400, "STUDIO_INVALID_REQUEST", message, details);
}

export function ingestionConflict(message: string, expectedSequence: number): StudioError {
  return new StudioError(409, "STUDIO_INGESTION_CONFLICT", message, {
    expectedSequence,
  });
}
