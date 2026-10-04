import { randomUUID } from "node:crypto";
import {
  hashNamespace,
  type MemoryError,
  type MemoryOperation,
  type MemoryOperationEvent,
} from "@yiku/memories";
import type { AgentProgressHandler } from "../runtime/types.js";

interface MemoryProgressDetails {
  readonly code?: string | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly mode?: "hybrid" | "lexical" | undefined;
}

export interface MemoryProgressSpan {
  end(details?: MemoryProgressDetails): void;
  error(error: unknown): void;
}

export function startMemoryProgress(
  onEvent: AgentProgressHandler,
  operation: MemoryOperation,
  namespace: string | undefined,
): MemoryProgressSpan {
  const operationId = randomUUID();
  const startedAt = new Date().toISOString();
  let ended = false;
  const base = {
    namespaceHash: hashNamespace(namespace?.trim() || "unknown"),
    operation,
    operationId,
    startedAt,
  };

  emitMemoryProgress(onEvent, {
    ...base,
    phase: "start",
  });

  return {
    end(details = {}) {
      if (ended) {
        return;
      }
      ended = true;
      const endedAt = new Date().toISOString();
      emitMemoryProgress(onEvent, {
        ...base,
        ...details,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        endedAt,
        phase: "end",
      });
    },
    error(error) {
      if (ended) {
        return;
      }
      ended = true;
      const endedAt = new Date().toISOString();
      emitMemoryProgress(onEvent, {
        ...base,
        code: memoryErrorCode(error),
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        endedAt,
        phase: "error",
      });
    },
  };
}

function emitMemoryProgress(onEvent: AgentProgressHandler, event: MemoryOperationEvent): void {
  onEvent({
    ...event,
    type: "memory_operation",
  });
}

function memoryErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as MemoryError).code === "string"
    ? (error as MemoryError).code
    : "MEMORY_OPERATION_FAILED";
}
