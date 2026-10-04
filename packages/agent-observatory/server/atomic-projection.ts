import { type AtomicFlowEvent, isTraceObservationEvent } from "@yiku/atomic-flow";
import type { AgentSessionSummary, EvalScorecard, StudioRunStatus } from "./types.js";

export function functionalAtomicEventCount(events: readonly AtomicFlowEvent[]): number {
  return events.filter((event) => !isTraceObservationEvent(event)).length;
}

export function projectAtomicRunStatus(
  event: AtomicFlowEvent,
  current?: StudioRunStatus,
): StudioRunStatus {
  if (
    current === "cancelled" ||
    current === "degraded" ||
    current === "failed" ||
    current === "needs-review"
  ) {
    return current;
  }
  if (event.atom.key === "flow.sink-error" || event.atom.key === "observability.degraded") {
    return "degraded";
  }
  if (event.atom.key === "eval.trigger" && event.phase === "start") {
    return "evaluating";
  }
  if (event.atom.key === "eval.gate" && event.phase === "end") {
    const decision = event.payload?.summary;
    return decision === "accepted"
      ? "accepted"
      : decision === "degraded"
        ? "degraded"
        : decision === "needs-review"
          ? "needs-review"
          : "rejected";
  }
  if (current === "evaluating") {
    return current;
  }
  if (event.atom.key === "run" && event.phase === "start") {
    return "running";
  }
  if (event.atom.key === "run" && event.phase === "error") {
    return event.payload?.code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed";
  }
  if (event.atom.key === "run" && event.phase === "end") {
    return "completed";
  }
  if (current === "accepted" || current === "completed" || current === "rejected") {
    return current;
  }
  return "running";
}

export function deriveAtomicScorecard(
  events: readonly AtomicFlowEvent[],
): EvalScorecard | undefined {
  const scorecardEvent = events.findLast(
    (event) => event.atom.key === "eval.scorecard" && event.phase === "end",
  );
  const averageScore = scorecardEvent?.payload?.values?.averageScore;
  const passed = scorecardEvent?.payload?.values?.passed;
  if (
    scorecardEvent === undefined ||
    typeof averageScore !== "number" ||
    typeof passed !== "boolean"
  ) {
    return undefined;
  }
  const triggerSequence =
    events.findLast(
      (event) =>
        event.atom.key === "eval.trigger" &&
        event.phase === "start" &&
        event.sequence < scorecardEvent.sequence,
    )?.sequence ?? 0;
  const attemptId = stringValue(
    events.findLast(
      (event) =>
        event.atom.key === "eval.trigger" &&
        event.phase === "start" &&
        event.sequence < scorecardEvent.sequence,
    )?.payload?.values?.attemptId,
  );
  const decision = events.find(
    (event) =>
      event.atom.key === "eval.decision" &&
      event.phase === "end" &&
      event.sequence > scorecardEvent.sequence,
  )?.payload?.summary;
  const values = scorecardEvent.payload?.values;
  const counts = scorecardEvent.payload?.counts;
  const overallScore = numberValue(values?.overallScore);
  const grade = gradeValue(values?.grade);
  const dimensionScores =
    numberValue(values?.correctness) !== undefined &&
    numberValue(values?.performance) !== undefined &&
    numberValue(values?.resourceEfficiency) !== undefined &&
    numberValue(values?.safetyReliability) !== undefined
      ? {
          correctness: numberValue(values?.correctness) as number,
          performance: numberValue(values?.performance) as number,
          "resource-efficiency": numberValue(values?.resourceEfficiency) as number,
          "safety-reliability": numberValue(values?.safetyReliability) as number,
        }
      : undefined;

  return {
    averageScore,
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(statusCounts(counts) !== undefined ? { counts: statusCounts(counts) } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(dimensionScores !== undefined ? { dimensionScores } : {}),
    ...(grade !== undefined ? { grade } : {}),
    ...(overallScore !== undefined ? { overallScore } : {}),
    passed,
    results: events.flatMap((event) => {
      if (
        event.sequence <= triggerSequence ||
        event.sequence > scorecardEvent.sequence ||
        event.atom.kind !== "eval" ||
        event.atom.key === "eval.trigger" ||
        event.atom.key === "eval.attempt" ||
        event.atom.key === "eval.scorecard" ||
        (event.phase !== "end" && event.phase !== "error" && event.phase !== "skipped")
      ) {
        return [];
      }
      const score = event.payload?.values?.score;
      const resultPassed = event.payload?.values?.passed;
      const status = statusValue(event.payload?.values?.status);
      return [
        {
          ...(event.payload?.code !== undefined ? { errorCode: event.payload.code } : {}),
          key: event.atom.key.slice("eval.".length),
          label: event.atom.label,
          passed: typeof resultPassed === "boolean" ? resultPassed : false,
          score: typeof score === "number" ? score : 0,
          ...(status !== undefined ? { status } : {}),
          summary: event.payload?.summary ?? event.payload?.code ?? "Evaluator failed.",
        },
      ];
    }),
  };
}

function statusCounts(
  counts: Readonly<Record<string, number>> | undefined,
): EvalScorecard["counts"] {
  if (
    counts === undefined ||
    !["error", "failed", "not-run", "passed"].every(
      (key) => Number.isSafeInteger(counts[key]) && (counts[key] ?? -1) >= 0,
    )
  ) {
    return undefined;
  }
  return {
    error: counts.error as number,
    failed: counts.failed as number,
    "not-run": counts["not-run"] as number,
    passed: counts.passed as number,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function gradeValue(value: unknown): EvalScorecard["grade"] {
  return value === "S" || value === "A" || value === "B" || value === "C" || value === "D"
    ? value
    : undefined;
}

function statusValue(
  value: unknown,
): NonNullable<EvalScorecard["results"][number]["status"]> | undefined {
  return value === "error" || value === "failed" || value === "not-run" || value === "passed"
    ? value
    : undefined;
}

export function deriveAtomicRunOutput(events: readonly AtomicFlowEvent[]): string | undefined {
  const value = events.findLast(
    (event) => event.atom.key === "reply.final" && event.phase === "end",
  )?.payload?.values?.output;
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function deriveAgentSessions(
  events: readonly AtomicFlowEvent[],
): readonly AgentSessionSummary[] {
  const sessions = new Map<
    string,
    { readonly sequence: number; readonly summary: AgentSessionSummary }
  >();

  for (const event of events) {
    if (event.atom.key !== "subagent.lifecycle") {
      continue;
    }
    if (event.phase === "start") {
      const values = event.payload?.values;
      const agentId = stringValue(values?.agentId);
      const agentSessionId = stringValue(values?.agentSessionId);
      const taskId = stringValue(values?.taskId);
      if (agentId === undefined || agentSessionId === undefined || taskId === undefined) {
        continue;
      }
      sessions.set(event.instance.id, {
        sequence: event.sequence,
        summary: {
          agentId,
          agentName:
            stringValue(values?.agentName) ??
            stringValue(values?.profileId) ??
            stringValue(values?.agentType) ??
            "subagent",
          agentSessionId,
          agentType: stringValue(values?.agentType) ?? "unknown",
          parentSessionId: stringValue(values?.parentSessionId) ?? "",
          status: "running",
          taskId,
        },
      });
      continue;
    }
    if (event.phase !== "end" && event.phase !== "error") {
      continue;
    }
    const current = sessions.get(event.instance.id);
    if (current === undefined) {
      continue;
    }
    sessions.set(event.instance.id, {
      ...current,
      summary: {
        ...current.summary,
        status: subagentStatus(event.payload?.summary, event.phase),
      },
    });
  }

  return [...sessions.values()]
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.summary);
}

function subagentStatus(
  summary: string | undefined,
  phase: AtomicFlowEvent["phase"],
): AgentSessionSummary["status"] {
  if (summary === "cancelled" || summary === "failed" || summary === "succeeded") {
    return summary;
  }
  return phase === "end" ? "succeeded" : "failed";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
