import {
  Activity,
  BookOpenCheck,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import type {
  FlowEdgeView,
  FlowNodeView,
  ObservatoryStatus,
  ResearchTurnSnapshot,
  RunStreamEvent,
} from "../types.js";
import { EventTimeline } from "./event-timeline.js";
import { FlowGraph } from "./flow-graph.js";

type InspectorTab = "evidence" | "events" | "flow";

interface ResearchInspectorProps {
  readonly edges: readonly FlowEdgeView[];
  readonly events: readonly RunStreamEvent[];
  readonly nodes: readonly FlowNodeView[];
  readonly observatory: ObservatoryStatus;
  readonly turn?: ResearchTurnSnapshot | undefined;
}

const TABS = [
  { icon: GitBranch, id: "flow", label: "流程" },
  { icon: BookOpenCheck, id: "evidence", label: "证据" },
  { icon: Activity, id: "events", label: "事件" },
] as const;

export function ResearchInspector({
  edges,
  events,
  nodes,
  observatory,
  turn,
}: ResearchInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("flow");
  const evidence = turn?.evidence ?? [];

  return (
    <aside className="research-inspector">
      <header className="inspector-header">
        <div>
          <span>LIVE RUN</span>
          <strong>{turn === undefined ? "等待研究" : statusLabel(turn.status)}</strong>
        </div>
        <div className="inspector-header-actions">
          {turn === undefined ? null : (
            <button
              aria-label="在 Observatory 中查看当前研究轨迹"
              disabled={!observatory.available || !observatory.url}
              onClick={() => {
                window.open(
                  observatoryRunUrl(observatory.url, turn.turnId),
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
              title={observatory.available ? "打开完整 Trajectory" : "Observatory 正在启动"}
              type="button"
            >
              {observatory.available ? <ExternalLink size={12} /> : <LoaderCircle size={12} />}
              <span>{observatory.available ? "TRAJECTORY" : "PREPARING"}</span>
            </button>
          )}
          <span className={`inspector-status is-${turn?.status ?? "idle"}`} />
        </div>
      </header>

      <div className="inspector-metrics">
        <Metric label="Queries" value={searchCount(events)} />
        <Metric label="Evidence" value={evidence.length} />
        <Metric label="Tokens" value={turn?.usage?.totalTokens ?? 0} />
      </div>

      <div className="inspector-tabs" role="tablist">
        {TABS.map(({ icon: Icon, id, label }) => (
          <button
            aria-selected={tab === id}
            className={tab === id ? "is-active" : ""}
            key={id}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      <div className="inspector-content">
        {tab === "flow" ? <FlowGraph edges={edges} nodes={nodes} /> : null}
        {tab === "evidence" ? (
          <section className="evidence-panel">
            <header className="section-heading">
              <div>
                <span className="eyebrow">EVIDENCE LEDGER</span>
                <h2>来源与主张</h2>
              </div>
              <ShieldCheck size={15} />
            </header>
            {evidence.length === 0 ? (
              <p className="inspector-empty">搜索结果通过校验后会写入 Evidence Ledger。</p>
            ) : (
              <ol className="evidence-list">
                {evidence.map((item, index) => (
                  <li key={item.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <a href={item.url} rel="noreferrer" target="_blank">
                        {item.title}
                      </a>
                      <p>{item.claims.join(" · ")}</p>
                      <small>
                        {item.sourceType} / {item.verification}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
        {tab === "events" ? <EventTimeline events={events} /> : null}
      </div>

      <footer className="validation-footer">
        <ShieldCheck size={13} />
        <span>CITATION VALIDATION</span>
        <strong className={turn?.validation?.passed ? "is-passed" : ""}>
          {turn?.validation === undefined
            ? "PENDING"
            : turn.validation.passed
              ? "PASSED"
              : "FAILED"}
        </strong>
      </footer>
    </aside>
  );
}

export function observatoryRunUrl(baseUrl: string, runId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("runId", runId);
  url.searchParams.set("view", "trajectory");
  return url.toString();
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toLocaleString("zh-CN")}</strong>
    </div>
  );
}

function searchCount(events: readonly RunStreamEvent[]): number {
  return events.filter(
    (event) =>
      event.type === "flow" &&
      event.data.atom.key === "research.search" &&
      event.data.phase === "start",
  ).length;
}

function statusLabel(status: ResearchTurnSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "QUEUED";
    case "running":
      return "RESEARCHING";
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
  }
}
