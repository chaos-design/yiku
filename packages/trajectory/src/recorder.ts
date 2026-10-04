import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import type { OperationEvent, Trajectory, TrajectoryStep } from "./types.js";

export class TrajectoryRecorder {
  private readonly steps = new Map<string, TrajectoryStep>();
  private endedAt: string | undefined;
  private readonly startedAt: string;

  public constructor(
    private readonly id: string,
    startedAt = new Date().toISOString(),
  ) {
    this.startedAt = startedAt;
  }

  public record(event: OperationEvent): void {
    const currentStep = this.steps.get(event.operationId);

    if (event.kind === "run" && (event.phase === "end" || event.phase === "error")) {
      this.endedAt = event.endedAt ?? new Date().toISOString();
    }

    this.steps.set(event.operationId, {
      ...(currentStep ?? {
        id: event.operationId,
        kind: event.kind,
        name: event.name,
        startedAt: event.startedAt,
        status: event.status,
      }),
      ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
      status: event.status,
    });
  }

  public recordAtomic(event: AtomicFlowEvent): void {
    const currentStep = this.steps.get(event.instance.id);

    if (event.atom.key === "run" && (event.phase === "end" || event.phase === "error")) {
      this.endedAt = event.occurredAt;
    }

    this.steps.set(event.instance.id, {
      ...(currentStep ?? {
        atomKey: event.atom.key,
        id: event.instance.id,
        kind: event.atom.kind,
        name: event.atom.label,
        startedAt: event.occurredAt,
        status: atomicStatus(event),
      }),
      ...(event.phase === "end" || event.phase === "error" || event.phase === "skipped"
        ? { endedAt: event.occurredAt }
        : {}),
      ...(event.phase === "error" && event.payload?.summary !== undefined
        ? { error: event.payload.summary }
        : {}),
      ...(event.instance.iteration !== undefined ? { iteration: event.instance.iteration } : {}),
      ...(event.instance.parentId !== undefined ? { parentId: event.instance.parentId } : {}),
      ...(event.payload !== undefined ? { output: event.payload } : {}),
      status: atomicStatus(event),
    });
  }

  public snapshot(): Trajectory {
    return {
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      id: this.id,
      startedAt: this.startedAt,
      steps: [...this.steps.values()],
    };
  }
}

function atomicStatus(event: AtomicFlowEvent): TrajectoryStep["status"] {
  switch (event.phase) {
    case "end":
    case "skipped":
      return "completed";
    case "error":
      return "failed";
    case "scheduled":
    case "start":
    case "delta":
      return "running";
  }
}
