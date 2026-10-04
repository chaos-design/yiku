import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import { MachineOutputState, stringifyMachineValue } from "./machine-output.js";
import type {
  CliJsonResult,
  CliMachineOutputFailure,
  CliMachineOutputSuccess,
  CliMachineOutputWriter,
  CliNdjsonEvent,
  CliNdjsonProgressEventType,
} from "./types.js";

const PROGRESS_EVENT_TYPES = {
  agent_profile_changed: "agent-profile.changed",
  agent_updated: "agent.updated",
  checkpoint_saved: "checkpoint.saved",
  context_compacted: "context.compacted",
  evaluation_finished: "verification.completed",
  handoff: "agent.handoff",
  memory_operation: "memory.operation",
  message_delta: "message.delta",
  prompt_risk_detected: "prompt.risk-detected",
  reasoning: "reasoning.updated",
  runtime_boundary_changed: "runtime-boundary.changed",
  session_resumed: "session.resumed",
  session_started: "session.started",
  skill_activated: "skill.activated",
  skill_resolved: "skill.resolved",
  skill_worker_finished: "skill-worker.finished",
  skill_worker_started: "skill-worker.started",
  stage_finished: "stage.finished",
  stage_started: "stage.started",
  subagent_output: "subagent.output",
  subagent_result: "subagent.finished",
  subagent_spawned: "subagent.started",
  task_snapshot: "task.snapshot",
  tool_called: "tool.started",
  tool_output: "tool.completed",
  usage_updated: "usage.updated",
  user_question_cancelled: "question.cancelled",
  user_question_requested: "question.requested",
  user_question_resolved: "question.resolved",
} as const satisfies Partial<
  Readonly<Record<AgentProgressEvent["type"], CliNdjsonProgressEventType>>
>;

export class NdjsonOutputWriter implements CliMachineOutputWriter {
  private readonly state = new MachineOutputState();

  public constructor(private readonly stdout: NodeJS.WriteStream) {}

  public observe(event: AgentProgressEvent): void {
    this.state.observe(event);
    const type = progressEventType(event);
    if (type !== undefined) {
      this.write({ event, type });
    }
  }

  public writeFailure(input: CliMachineOutputFailure): CliJsonResult {
    const result = this.state.failure(input);
    this.write({ ...result, type: "session.failed" });
    return result;
  }

  public writeSuccess(input: CliMachineOutputSuccess): CliJsonResult {
    const result = this.state.success(input);
    this.write({
      ...result,
      type: result.status === "completed" ? "session.completed" : "session.failed",
    });
    return result;
  }

  private write(event: CliNdjsonEvent): void {
    this.stdout.write(`${stringifyMachineValue(event)}\n`);
  }
}

function progressEventType(event: AgentProgressEvent): CliNdjsonProgressEventType | undefined {
  if (
    event.type === "session_cancelled" ||
    event.type === "session_failed" ||
    event.type === "session_finished"
  ) {
    return undefined;
  }
  return PROGRESS_EVENT_TYPES[event.type];
}
