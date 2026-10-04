import { type StudioServerPlugin, studioManifest } from "@yiku/agent-studio/server";
import type { AtomicFlowEvent } from "@yiku/atomic-flow";
import {
  deriveAgentSessions,
  deriveAtomicRunOutput,
  deriveAtomicScorecard,
  functionalAtomicEventCount,
  projectAtomicRunStatus,
} from "./atomic-projection.js";
import { parseIngestEvent } from "./ingestion.js";
import { compactJson, toJson } from "./json.js";
import type { StudioRunStatus } from "./types.js";

export const AGENT_OBSERVATORY_SERVER_MANIFEST = studioManifest(
  "yiku.agent-observatory",
  "Yiku Agent Observatory",
  ["events.atomic-flow", "graph.atomic-flow", "runs.history", "runs.replay"],
);

export function agentObservatoryServerPlugin(): StudioServerPlugin {
  return {
    adapters: [
      {
        id: "atomic-flow",
        parse: (value) => {
          const input = parseIngestEvent(value);
          const prompt = input.run?.prompt?.trim();
          return {
            event: input.event,
            seed: {
              createdAt: input.event.occurredAt,
              metadata: compactJson({
                agentKey: input.run?.agentKey?.trim(),
                agentName: input.run?.agentName?.trim(),
                agentType: input.run?.agentType?.trim(),
                evalMode: "blocking",
                kind: input.run?.kind ?? "agent",
                projectId: input.project?.id?.trim(),
                projectName: input.project?.name?.trim(),
                prompt,
                sessionId: input.run?.sessionId?.trim(),
                source: "external",
              }),
              runId: input.event.runId,
              status: projectAtomicRunStatus(input.event),
              title: prompt || `External run ${shortRunId(input.event.runId)}`,
            },
          };
        },
      },
    ],
    manifest: AGENT_OBSERVATORY_SERVER_MANIFEST,
    projectors: [
      {
        id: "atomic-flow-run",
        project: ({ current, event, events }) => {
          const atomicEvents = events as readonly AtomicFlowEvent[];
          const agentSessions = deriveAgentSessions(atomicEvents);
          const output = deriveAtomicRunOutput(atomicEvents);
          const scorecard = deriveAtomicScorecard(atomicEvents);
          return {
            eventCount: functionalAtomicEventCount(atomicEvents),
            ...(scorecard === undefined && output === undefined && agentSessions.length === 0
              ? {}
              : {
                  metadata: {
                    ...current.metadata,
                    ...(agentSessions.length > 0 ? { agentSessions: toJson(agentSessions) } : {}),
                    ...(output !== undefined ? { output } : {}),
                    ...(scorecard !== undefined ? { scorecard: toJson(scorecard) } : {}),
                  },
                }),
            status: projectAtomicRunStatus(
              event as AtomicFlowEvent,
              current.status as StudioRunStatus,
            ),
          };
        },
      },
    ],
    statuses: [
      status("queued", "Queued", "pending", "neutral"),
      status("running", "Running", "active", "info"),
      status("evaluating", "Evaluating", "active", "warning"),
      status("needs-review", "Needs Review", "terminal", "warning"),
      status("accepted", "Accepted", "terminal", "success"),
      status("completed", "Completed", "terminal", "success"),
      status("rejected", "Rejected", "terminal", "danger"),
      status("failed", "Failed", "terminal", "danger"),
      status("cancelled", "Cancelled", "terminal", "neutral"),
      status("degraded", "Degraded", "terminal", "warning"),
    ],
  };
}

function status(
  key: StudioRunStatus,
  label: string,
  lifecycle: "active" | "pending" | "terminal",
  tone: "danger" | "info" | "neutral" | "success" | "warning",
) {
  return { key, label, lifecycle, tone } as const;
}

function shortRunId(runId: string): string {
  return runId.length <= 12 ? runId : `${runId.slice(0, 12)}...`;
}
