import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceEntry, TraceOptions } from "./types.js";

export class Trace<TEvent = unknown> {
  private step: number;
  private readonly getResult: (event: TEvent) => unknown;

  public constructor(
    private readonly traceFilePath: string,
    options: TraceOptions<TEvent> = {},
  ) {
    this.step = readLastStep(traceFilePath);
    this.getResult = options.getResult ?? getEventResult;
  }

  public record(event: TEvent): void {
    this.step += 1;
    this.write({
      event,
      recordedAt: new Date().toISOString(),
      ...(this.getResult(event) !== undefined ? { result: this.getResult(event) } : {}),
      step: this.step,
    });
  }

  private write(entry: TraceEntry<TEvent>): void {
    try {
      mkdirSync(dirname(this.traceFilePath), { recursive: true });
      appendFileSync(this.traceFilePath, `${JSON.stringify(entry)}\n`);
    } catch {
      // Trace persistence must never break the agent session.
    }
  }
}

export function readTraceEntries<TEvent = unknown>(
  traceFilePath: string,
): readonly TraceEntry<TEvent>[] {
  try {
    const content = readFileSync(traceFilePath, "utf8").trim();

    if (!content) {
      return [];
    }

    return content.split("\n").map((line) => JSON.parse(line) as TraceEntry<TEvent>);
  } catch {
    return [];
  }
}

function readLastStep(traceFilePath: string): number {
  const lastEntry = readTraceEntries(traceFilePath).at(-1);
  const step = lastEntry?.step;

  return typeof step === "number" && Number.isSafeInteger(step) && step >= 0 ? step : 0;
}

function getEventResult(event: unknown): unknown {
  const record = asRecord(event);

  switch (record?.type) {
    case "agent_updated":
      return record.agentName;
    case "checkpoint_saved":
      return record.checkpointRevision;
    case "context_compacted":
      return record.afterEntries;
    case "handoff":
      return record.targetAgentName;
    case "message_delta":
      return record.text;
    case "reasoning":
      return "reasoning";
    case "session_cancelled":
      return record.reason;
    case "session_failed":
      return record.error;
    case "session_finished":
      return record.output;
    case "session_resumed":
      return record.sessionId;
    case "session_started":
      return record.prompt;
    case "tool_called":
      return record.summary;
    case "tool_output":
      return record.output ?? record.summary;
    case "stage_finished":
      return record.outcome;
    case "stage_started":
      return record.stageId;
    case "subagent_output":
      return record.output;
    case "subagent_result":
      return {
        agentName: record.agentName ?? record.profileId ?? record.agentId,
        agentSessionId: record.agentSessionId,
        status: record.status,
        taskId: record.taskId,
      };
    case "subagent_spawned":
      return {
        agentName: record.agentName ?? record.profileId ?? record.agentType,
        agentSessionId: record.agentSessionId,
        taskId: record.taskId,
      };
    case "task_snapshot":
      return record.completed;
    case "usage_updated":
      return record.usage;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
