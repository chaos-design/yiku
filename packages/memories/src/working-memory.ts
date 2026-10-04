import type { WorkingMemoryRecord, WorkingMemoryStore } from "./types.js";

export class InMemoryWorkingMemoryStore implements WorkingMemoryStore {
  private readonly records = new Map<string, readonly WorkingMemoryRecord[]>();

  public async list(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
    return cloneRecords(this.records.get(requireSessionId(sessionId)) ?? []);
  }

  public async replace(
    sessionId: string,
    records: readonly WorkingMemoryRecord[],
  ): Promise<readonly WorkingMemoryRecord[]> {
    const normalizedSessionId = requireSessionId(sessionId);
    if (records.some((record) => record.sessionId !== normalizedSessionId)) {
      throw new Error("Working Memory records must belong to the requested Session.");
    }
    const next = cloneRecords(records);
    this.records.set(normalizedSessionId, next);
    return cloneRecords(next);
  }
}

function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error("Working Memory Session ID is invalid.");
  }
  return normalized;
}

function cloneRecords(records: readonly WorkingMemoryRecord[]): readonly WorkingMemoryRecord[] {
  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        ...record,
        ...(record.draft !== undefined
          ? {
              draft: Object.freeze({
                ...record.draft,
                ...(record.draft.metadata !== undefined
                  ? { metadata: Object.freeze({ ...record.draft.metadata }) }
                  : {}),
                ...(record.draft.tags !== undefined
                  ? { tags: Object.freeze([...record.draft.tags]) }
                  : {}),
              }),
            }
          : {}),
      }),
    ),
  );
}
