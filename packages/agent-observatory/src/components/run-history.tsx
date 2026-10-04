import { Activity, CheckCircle2, CircleX, Clock3 } from "lucide-react";
import type { AgentSessionSummary, RunSummary } from "../types.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

interface RunHistoryProps {
  readonly onSelect: (runId: string, agentId?: string) => void;
  readonly runs: readonly RunSummary[];
  readonly selectedAgentId?: string | undefined;
  readonly selectedRunId?: string | undefined;
}

interface HistoryRow {
  readonly agent?: AgentSessionSummary | undefined;
  readonly key: string;
  readonly run: RunSummary;
}

interface HistoryAgentTag {
  readonly label: "Agent Name" | "Session" | "Type";
  readonly value: string;
}

interface HistoryContent {
  readonly agentTags: readonly HistoryAgentTag[];
  readonly metadata: readonly string[];
  readonly prompt: string;
}

export function RunHistory({ onSelect, runs, selectedAgentId, selectedRunId }: RunHistoryProps) {
  const agentCount = runs.reduce((count, run) => count + (run.agentSessions?.length ?? 0), 0);
  return (
    <section className="run-history">
      <header>
        <span className="eyebrow">RUN HISTORY</span>
        <strong>
          {runs.length} runs · {agentCount} subagents
        </strong>
      </header>
      <TooltipProvider>
        <div>
          {historyRows(runs).map((row) => {
            const content =
              row.agent === undefined
                ? runHistoryContent(row.run)
                : agentHistoryContent(row.agent, row.run);
            const selected =
              selectedRunId === row.run.runId &&
              (row.agent === undefined
                ? selectedAgentId === undefined
                : selectedAgentId === row.agent.agentId);
            return (
              <Tooltip key={row.key}>
                <TooltipTrigger asChild>
                  <button
                    className={`${selected ? "is-selected" : ""}${
                      row.agent === undefined ? "" : " is-child"
                    }`}
                    onClick={() => onSelect(row.run.runId, row.agent?.agentId)}
                    type="button"
                  >
                    {statusIcon(row.agent?.status ?? row.run.status)}
                    <span>
                      <strong>{content.prompt}</strong>
                      <small className="run-history-meta">
                        <span className="run-history-meta-row">{content.metadata[0]}</span>
                        <AgentTags tags={content.agentTags} />
                        {content.metadata.slice(1).map((line) => (
                          <span className="run-history-meta-row" key={line}>
                            {line}
                          </span>
                        ))}
                      </small>
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent align="start" side="right" sideOffset={8}>
                  <div className="run-history-tooltip">
                    <strong>{content.prompt}</strong>
                    <span>{content.metadata[0]}</span>
                    <AgentTags tags={content.agentTags} />
                    {content.metadata.slice(1).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </section>
  );
}

function AgentTags({ tags }: { readonly tags: readonly HistoryAgentTag[] }) {
  return (
    <span className="run-history-agent-tags">
      {tags.map((tag) => (
        <span className="run-history-agent-tag" key={tag.label}>
          <span>{tag.label}</span>
          <span className="run-history-agent-tag-value">{tag.value}</span>
        </span>
      ))}
    </span>
  );
}

export function runHistoryContent(run: RunSummary): HistoryContent {
  return {
    agentTags: agentTags(
      run.agentName ?? run.agentKey ?? "Unknown agent",
      run.agentType ?? "unknown",
      run.sessionId ?? "no session",
    ),
    metadata: [
      `${formatRunTime(run.createdAt)} · ${(run.kind ?? "agent").toUpperCase()}`,
      `${run.projectName ?? run.source} · ${shortId(run.runId)} · ${run.eventCount} events`,
    ],
    prompt: run.prompt,
  };
}

function agentHistoryContent(agent: AgentSessionSummary, run: RunSummary): HistoryContent {
  return {
    agentTags: agentTags(agent.agentName, agent.agentType, agent.agentSessionId),
    metadata: [
      `SUBAGENT · ${agent.status.toUpperCase()}`,
      `Task ${shortId(agent.taskId)}`,
      `Parent ${run.agentName ?? run.agentKey ?? "agent"} · ${shortId(run.runId)}`,
    ],
    prompt: agent.agentName,
  };
}

function agentTags(name: string, type: string, sessionId: string): readonly HistoryAgentTag[] {
  return [
    { label: "Agent Name", value: name },
    { label: "Type", value: type },
    { label: "Session", value: shortId(sessionId) },
  ];
}

function historyRows(runs: readonly RunSummary[]): readonly HistoryRow[] {
  return runs.flatMap((run) => [
    { key: `run:${run.runId}`, run },
    ...(run.agentSessions ?? []).map((agent) => ({
      agent,
      key: `run:${run.runId}:agent:${agent.agentId}`,
      run,
    })),
  ]);
}

function formatRunTime(createdAt: string): string {
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.valueOf())) {
    return "--:--";
  }
  return `${timestamp.getFullYear()}-${padTime(timestamp.getMonth() + 1)}-${padTime(
    timestamp.getDate(),
  )} ${padTime(timestamp.getHours())}:${padTime(timestamp.getMinutes())}:${padTime(
    timestamp.getSeconds(),
  )}`;
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}

function statusIcon(status: AgentSessionSummary["status"] | RunSummary["status"]) {
  if (status === "accepted" || status === "completed") {
    return <CheckCircle2 className="status-success" size={14} />;
  }
  if (
    status === "failed" ||
    status === "rejected" ||
    status === "cancelled" ||
    status === "needs-review"
  ) {
    return <CircleX className="status-failure" size={14} />;
  }
  if (status === "running" || status === "evaluating") {
    return <Activity className="status-running" size={14} />;
  }
  return <Clock3 size={14} />;
}
