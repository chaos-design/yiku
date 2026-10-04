import type { AtomicFlowEvent, AtomicFlowSink, AtomicSinkReceiptDraft } from "@yiku/atomic-flow";
import { TRAJECTORY_ATOMS } from "./atoms.js";
import { TrajectoryRecorder } from "./recorder.js";
import type { Trajectory } from "./types.js";

const PROJECTED_PHASES = new Set<AtomicFlowEvent["phase"]>(["end", "error", "skipped"]);

export class AtomicTrajectorySink implements AtomicFlowSink {
  public readonly id = "trajectory";
  private readonly recorder: TrajectoryRecorder;

  public constructor(runId: string, startedAt?: string) {
    this.recorder = new TrajectoryRecorder(runId, startedAt);
  }

  public write(event: AtomicFlowEvent): AtomicSinkReceiptDraft | undefined {
    this.recorder.recordAtomic(event);

    if (event.internal === true || !PROJECTED_PHASES.has(event.phase)) {
      return undefined;
    }

    return {
      atom: TRAJECTORY_ATOMS.project,
      payload: {
        counts: {
          projectedSequence: event.sequence,
        },
      },
    };
  }

  public snapshot(): Trajectory {
    return this.recorder.snapshot();
  }
}
