import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { ChevronDown, ChevronRight, CornerUpRight } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import type { RunDetail } from "../types.js";

interface MessageInspectorProps {
  readonly event?: AtomicFlowEvent | undefined;
  readonly events?: readonly AtomicFlowEvent[] | undefined;
  readonly run?: RunDetail | undefined;
}

const SCORECARD_REGION_ID = "run-evaluation-scorecard";
const SCORECARD_COLLAPSED_STORAGE_KEY = "yiku:agent-observatory:scorecard-collapsed";

export function MessageInspector({ event, events, run }: MessageInspectorProps) {
  const [scorecardExpanded, setScorecardExpanded] = useState(storedScorecardExpanded);
  const availableEvents = events ?? run?.events ?? [];
  const data = inspectorData(event, availableEvents, run);
  const scorecard = run?.scorecard;

  return (
    <section className="message-inspector">
      <header className="panel-header">
        <div>
          <span className="eyebrow">EVENT INSPECTOR</span>
          <strong>
            {event === undefined ? "No event selected" : `Sequence ${event.sequence}`}
          </strong>
        </div>
        {event !== undefined || scorecard !== undefined ? (
          <div className="inspector-header-actions">
            {event !== undefined ? (
              <span className="linked-atom">
                <CornerUpRight size={11} />
                {event.atom.label}
              </span>
            ) : null}
            {scorecard !== undefined ? (
              <button
                aria-controls={SCORECARD_REGION_ID}
                aria-expanded={scorecardExpanded}
                aria-label={`${scorecardExpanded ? "Collapse" : "Expand"} quality gate scorecard`}
                className="inspector-scorecard-toggle"
                onClick={() => {
                  const expanded = !scorecardExpanded;
                  storeScorecardExpanded(expanded);
                  setScorecardExpanded(expanded);
                }}
                title={`${scorecardExpanded ? "Collapse" : "Expand"} quality gate scorecard`}
                type="button"
              >
                {scorecardExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {scorecard !== undefined ? (
        <div
          aria-hidden={!scorecardExpanded}
          className={`eval-summary-region${scorecardExpanded ? " is-expanded" : ""}`}
          id={SCORECARD_REGION_ID}
        >
          <EvalSummary scorecard={scorecard} />
        </div>
      ) : null}
      <pre className="json-viewer">
        {data === undefined ? (
          "Select an atomic log row to inspect its event envelope."
        ) : (
          <JsonValue value={data} />
        )}
      </pre>
    </section>
  );
}

function storedScorecardExpanded(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(SCORECARD_COLLAPSED_STORAGE_KEY) !== "true";
  } catch {
    return true;
  }
}

function storeScorecardExpanded(expanded: boolean): void {
  try {
    if (expanded) {
      window.localStorage.removeItem(SCORECARD_COLLAPSED_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SCORECARD_COLLAPSED_STORAGE_KEY, "true");
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function EvalSummary({ scorecard }: { readonly scorecard: NonNullable<RunDetail["scorecard"]> }) {
  const counts = scorecard.counts;
  const decision = scorecard.decision ?? (scorecard.passed ? "accepted" : "rejected");
  const overallScore = scorecard.overallScore ?? scorecard.averageScore;
  return (
    <div className="eval-summary" data-passed={scorecard.passed}>
      <div className="eval-summary-label">
        <span>Run evaluation</span>
        <strong>Quality gate scorecard</strong>
        <small>Run-level, not event-specific</small>
      </div>
      <div className="eval-summary-core">
        <div className="eval-summary-metric">
          <span>Decision</span>
          <strong>{decision}</strong>
        </div>
        <div>
          <span>Grade</span>
          <strong>{scorecard.grade ?? "-"}</strong>
          <small>{(overallScore * 100).toFixed(1)} score</small>
        </div>
        {counts !== undefined ? (
          <div>
            <span>Checks</span>
            <strong>
              {counts.passed} / {counts.failed} / {counts.error} / {counts["not-run"]}
            </strong>
            <small>pass / fail / error / skip</small>
          </div>
        ) : null}
      </div>
      {scorecard.dimensionScores !== undefined ? (
        <div className="eval-summary-dimensions">
          {Object.entries(scorecard.dimensionScores).map(([dimension, score]) => (
            <div className="eval-dimension" key={dimension}>
              <span title={dimension}>{dimension.replaceAll("-", " ")}</span>
              <strong>{(score * 100).toFixed(1)}</strong>
              <div aria-hidden="true" className="eval-dimension-bar">
                <i style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JsonValue({ depth = 0, value }: { readonly depth?: number; readonly value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="json-null">{value === null ? "null" : "undefined"}</span>;
  }
  if (typeof value === "string") {
    return <span className="json-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-boolean">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return renderCollection(
      "[",
      "]",
      value.map((item, index) => [String(index), item]),
      depth,
      false,
    );
  }
  if (typeof value === "object") {
    return renderCollection("{", "}", Object.entries(value), depth, true);
  }
  return <span className="json-string">{JSON.stringify(String(value))}</span>;
}

function renderCollection(
  open: string,
  close: string,
  entries: readonly (readonly [string, unknown])[],
  depth: number,
  showKeys: boolean,
): ReactNode {
  if (entries.length === 0) {
    return (
      <span className="json-bracket">
        {open}
        {close}
      </span>
    );
  }
  return (
    <>
      <span className="json-bracket">{open}</span>
      {"\n"}
      {entries.map(([key, value], index) => (
        <Fragment key={key}>
          {indent(depth + 1)}
          {showKeys ? (
            <>
              <span className="json-key">{JSON.stringify(key)}</span>
              <span className="json-punctuation">: </span>
            </>
          ) : null}
          <JsonValue depth={depth + 1} value={value} />
          {index < entries.length - 1 ? <span className="json-punctuation">,</span> : null}
          {"\n"}
        </Fragment>
      ))}
      {indent(depth)}
      <span className="json-bracket">{close}</span>
    </>
  );
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function inspectorData(
  event: AtomicFlowEvent | undefined,
  events: readonly AtomicFlowEvent[],
  run: RunDetail | undefined,
): Record<string, unknown> | undefined {
  if (event === undefined && run === undefined) {
    return undefined;
  }
  return {
    atom: atomMessageData(event, events),
    correlation: capabilityCorrelation(event),
    message: {
      input: run?.prompt ?? null,
      output: run?.output ?? runOutput(events) ?? null,
    },
    event: event ?? null,
    run:
      run === undefined
        ? null
        : {
            createdAt: run.createdAt,
            error: run.error ?? null,
            eventCount: run.eventCount,
            kind: run.kind ?? "agent",
            projectName: run.projectName ?? null,
            runId: run.runId,
            scorecard: run.scorecard ?? null,
            sessionId: run.sessionId ?? null,
            source: run.source,
            status: run.status,
            updatedAt: run.updatedAt,
          },
  };
}

function atomMessageData(
  event: AtomicFlowEvent | undefined,
  events: readonly AtomicFlowEvent[],
): Readonly<Record<string, unknown>> | null {
  if (event === undefined) {
    return null;
  }
  const instanceEvents = [...events, event]
    .filter(
      (candidate, index, candidates) =>
        candidate.runId === event.runId &&
        candidate.atom.key === event.atom.key &&
        candidate.instance.id === event.instance.id &&
        candidates.findIndex((other) => other.sequence === candidate.sequence) === index,
    )
    .toSorted((left, right) => left.sequence - right.sequence);
  const start = instanceEvents.find(
    (candidate) => candidate.phase === "scheduled" || candidate.phase === "start",
  );
  const terminal = instanceEvents.findLast(
    (candidate) =>
      candidate.phase === "end" || candidate.phase === "error" || candidate.phase === "skipped",
  );
  return {
    parameters: start?.payload?.values?.input ?? null,
    payload: event.payload ?? null,
    result: terminal?.payload?.values?.output ?? null,
  };
}

function runOutput(events: readonly AtomicFlowEvent[]): unknown {
  return events.findLast((event) => event.atom.key === "reply.final" && event.phase === "end")
    ?.payload?.values?.output;
}

function capabilityCorrelation(
  event: AtomicFlowEvent | undefined,
): Readonly<Record<string, string>> | null {
  const payload = asRecord(event?.payload);
  const values = asRecord(payload?.values);
  const fields = ["profileId", "agentId", "taskId", "workerId", "digest"] as const;
  const correlation = Object.fromEntries(
    fields.flatMap((field) =>
      typeof values?.[field] === "string" ? [[field, values[field]]] : [],
    ),
  );
  return Object.keys(correlation).length === 0 ? null : correlation;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
