import { createHash, randomUUID } from "node:crypto";
import type {
  MemoryEventHandler,
  MemoryOperation,
  MemoryOperationEvent,
  MemoryOperationPhase,
} from "./types.js";

interface MemoryEventDetails {
  readonly code?: string | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly mode?: "hybrid" | "lexical" | undefined;
}

export class MemoryOperationSpan {
  private ended = false;

  public constructor(
    private readonly emitEvent: (event: MemoryOperationEvent) => void,
    private readonly namespaceHash: string,
    private readonly operation: MemoryOperation,
    private readonly operationId: string,
    private readonly startedAt: string,
    private readonly parentOperationId?: string | undefined,
  ) {
    this.emit("start");
  }

  public get id(): string {
    return this.operationId;
  }

  public end(details: MemoryEventDetails = {}): void {
    this.finish("end", details);
  }

  public error(code: string): void {
    this.finish("error", { code });
  }

  private finish(phase: "end" | "error", details: MemoryEventDetails): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.emit(phase, details);
  }

  private emit(phase: MemoryOperationPhase, details: MemoryEventDetails = {}): void {
    const endedAt = phase === "start" ? undefined : new Date().toISOString();

    this.emitEvent({
      ...(details.code !== undefined ? { code: details.code } : {}),
      ...(details.counts !== undefined ? { counts: details.counts } : {}),
      ...(endedAt !== undefined
        ? {
            durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(this.startedAt)),
            endedAt,
          }
        : {}),
      ...(details.mode !== undefined ? { mode: details.mode } : {}),
      namespaceHash: this.namespaceHash,
      operation: this.operation,
      operationId: this.operationId,
      ...(this.parentOperationId !== undefined
        ? { parentOperationId: this.parentOperationId }
        : {}),
      phase,
      startedAt: this.startedAt,
    });
  }
}

export class MemoryEvents {
  public constructor(private readonly handler?: MemoryEventHandler | undefined) {}

  public start(
    operation: MemoryOperation,
    namespace: string,
    parentOperationId?: string,
  ): MemoryOperationSpan {
    return new MemoryOperationSpan(
      (event) => this.emit(event),
      hashNamespace(namespace),
      operation,
      randomUUID(),
      new Date().toISOString(),
      parentOperationId,
    );
  }

  public emit(event: MemoryOperationEvent): void {
    try {
      this.handler?.(event);
    } catch {
      // Observability must never change memory behavior.
    }
  }
}

export function hashNamespace(namespace: string): string {
  return createHash("sha256").update(namespace).digest("hex").slice(0, 16);
}
