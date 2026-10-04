import type { AtomicFlowEvent, AtomicFlowRun } from "@yiku/atomic-flow";
import { TrajectoryRecorder } from "./recorder.js";
import type { ProjectTrajectoryOptions, Trajectory, TrajectorySubscriber } from "./types.js";

const EPOCH = new Date(0).toISOString();

export function projectTrajectory(
  events: readonly AtomicFlowEvent[],
  options: ProjectTrajectoryOptions = {},
): Trajectory {
  const orderedEvents = [...events].toSorted((left, right) => left.sequence - right.sequence);
  const eventRunId = orderedEvents[0]?.runId;
  const runId = eventRunId ?? requireRunId(options.runId);

  for (const event of orderedEvents) {
    if (event.runId !== runId) {
      throw new Error(
        `Trajectory events must belong to one run: expected ${runId}, received ${event.runId}.`,
      );
    }
  }

  const visibleEvents = orderedEvents.filter(
    (event) =>
      (options.throughSequence === undefined || event.sequence <= options.throughSequence) &&
      !isInternalObservation(event),
  );
  const recorder = new TrajectoryRecorder(
    runId,
    options.startedAt ?? visibleEvents[0]?.occurredAt ?? EPOCH,
  );

  for (const event of visibleEvents) {
    recorder.recordAtomic(event);
  }

  return recorder.snapshot();
}

export class AtomicTrajectoryProjection {
  private closed = false;
  private readonly events: AtomicFlowEvent[];
  private readonly listeners = new Set<TrajectorySubscriber>();
  private readonly runId: string;
  private startedAt: string | undefined;
  private readonly unsubscribe: () => void;

  public constructor(flow: AtomicFlowRun) {
    this.runId = flow.runId;
    this.events = [...flow.snapshot().events];
    this.startedAt = this.events[0]?.occurredAt;
    this.unsubscribe = flow.subscribe((event) => {
      if (this.closed) {
        return;
      }
      this.startedAt ??= event.occurredAt;
      this.events.push(event);
      const trajectory = this.snapshot();
      for (const listener of this.listeners) {
        try {
          listener(trajectory);
        } catch {
          // Projection subscribers cannot alter the source flow.
        }
      }
    });
  }

  public snapshot(options: Pick<ProjectTrajectoryOptions, "throughSequence"> = {}): Trajectory {
    return projectTrajectory(this.events, {
      runId: this.runId,
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...options,
    });
  }

  public subscribe(listener: TrajectorySubscriber): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listeners.clear();
    this.unsubscribe();
  }
}

export function observeTrajectory(flow: AtomicFlowRun): AtomicTrajectoryProjection {
  return new AtomicTrajectoryProjection(flow);
}

function isInternalObservation(event: AtomicFlowEvent): boolean {
  return (
    event.internal === true && (event.atom.kind === "trace" || event.atom.kind === "trajectory")
  );
}

function requireRunId(value: string | undefined): string {
  const runId = value?.trim();
  if (!runId) {
    throw new Error("Trajectory run ID is required when projecting an empty event list.");
  }
  return runId;
}
