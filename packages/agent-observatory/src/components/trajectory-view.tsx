import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { ArrowLeft, ChevronDown, ChevronRight, GitBranch, LocateFixed } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createTrajectoryView, type TrajectoryViewRow } from "../state/trajectory-view.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

type TrajectoryLane = "input" | "model" | "tools";

const OVERVIEW_STEP_WIDTH = 45;
const OVERVIEW_STEP_GAP = 4;

interface TrajectoryViewProps {
  readonly active?: boolean | undefined;
  readonly events: readonly AtomicFlowEvent[];
  readonly followActive?: boolean | undefined;
  readonly locateRequest?: number | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onLocateCurrent?: (() => void) | undefined;
  readonly onSelectSequence: (sequence: number) => void;
  readonly overviewRevealRequest?: number | undefined;
  readonly replaySequence: number;
  readonly selectedSequence?: number | undefined;
}

export function TrajectoryView({
  active = true,
  events,
  followActive = true,
  locateRequest = 0,
  onBack,
  onLocateCurrent,
  onSelectSequence,
  overviewRevealRequest = 0,
  replaySequence,
  selectedSequence,
}: TrajectoryViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const selectedRowRef = useRef<HTMLDivElement>(null);
  const locateRequestRef = useRef(locateRequest);
  const manualSelectionRef = useRef<number | undefined>(undefined);
  const rows = useMemo(
    () => createTrajectoryView(events, replaySequence),
    [events, replaySequence],
  );
  const visibleRows = useMemo(
    () => rows.filter((row) => !row.ancestorIds.some((id) => collapsed.has(id))),
    [collapsed, rows],
  );
  const groups = useMemo(() => trajectoryGroups(visibleRows), [visibleRows]);
  const completed = rows.filter((row) => row.status === "completed").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const running = rows.some((row) => row.status === "running");
  const turnCount = new Set(rows.flatMap((row) => (row.turn === undefined ? [] : [row.turn]))).size;

  useEffect(() => {
    const selectedRow = rows.find((row) => row.sequence === selectedSequence);
    if (selectedRow === undefined) {
      return;
    }
    setCollapsed((current) => {
      if (!selectedRow.ancestorIds.some((id) => current.has(id))) {
        return current;
      }
      const next = new Set(current);
      for (const ancestorId of selectedRow.ancestorIds) {
        next.delete(ancestorId);
      }
      return next;
    });
  }, [rows, selectedSequence]);

  useEffect(() => {
    const locateRequested = locateRequestRef.current !== locateRequest;
    const manuallySelected = manualSelectionRef.current === selectedSequence;
    locateRequestRef.current = locateRequest;
    manualSelectionRef.current = undefined;
    if (
      !active ||
      selectedSequence === undefined ||
      !visibleRows.some((row) => row.sequence === selectedSequence) ||
      (!followActive && !locateRequested) ||
      (manuallySelected && !locateRequested)
    ) {
      return;
    }
    selectedRowRef.current?.scrollIntoView({
      behavior: locateRequested ? "smooth" : "auto",
      block: "nearest",
    });
  }, [active, followActive, locateRequest, selectedSequence, visibleRows]);

  return (
    <section
      aria-label="Execution trajectory"
      className={`trajectory-view${active && followActive ? " is-live" : ""}${
        running ? " has-running-step" : ""
      }`}
    >
      <header className="trajectory-view-header">
        <div className="trajectory-heading">
          {!followActive && onBack !== undefined ? (
            <button
              aria-label="Back to run overview"
              className="trajectory-back"
              onClick={onBack}
              title="Return to latest run state"
              type="button"
            >
              <ArrowLeft size={12} />
            </button>
          ) : null}
          <div>
            <span className="eyebrow">RUN TRAJECTORY</span>
            <strong>{followActive ? "Live execution stream" : "Historical event detail"}</strong>
          </div>
          {onLocateCurrent !== undefined ? (
            <button
              aria-label="Locate current trajectory step"
              className="trajectory-locate"
              disabled={selectedSequence === undefined}
              onClick={onLocateCurrent}
              title="Locate current trajectory step"
              type="button"
            >
              <LocateFixed size={12} />
            </button>
          ) : null}
        </div>
        <div className="trajectory-view-metrics">
          <span>{turnCount} turns</span>
          <span>{rows.length} steps</span>
          <span>{completed} complete</span>
          <span className={failed > 0 ? "has-failures" : ""}>{failed} failed</span>
        </div>
      </header>

      <TrajectoryOverview
        active={active}
        revealRequest={overviewRevealRequest}
        rows={rows}
        selectedSequence={selectedSequence}
      />

      {visibleRows.length === 0 ? (
        <div className="trajectory-empty">
          <GitBranch size={22} strokeWidth={1.25} />
          <strong>No trajectory steps</strong>
          <span>Run events will appear here as instances are created.</span>
        </div>
      ) : (
        <div className="trajectory-list" role="tree">
          {groups.map((group) => (
            <section className="trajectory-turn" key={group.key} role="presentation">
              <header className="trajectory-turn-header">
                <span>{group.label}</span>
                <small>{group.rows.length} steps</small>
              </header>
              {group.rows.map((row) => {
                const isCollapsed = collapsed.has(row.id);
                const selected = row.sequence === selectedSequence;
                return (
                  <div
                    aria-expanded={row.hasChildren ? !isCollapsed : undefined}
                    aria-level={row.depth + 1}
                    className={`trajectory-row status-${row.status}${
                      selected ? " is-selected" : ""
                    }`}
                    key={row.id}
                    ref={selected ? selectedRowRef : undefined}
                    role="treeitem"
                    style={{ "--trajectory-depth": row.depth } as CSSProperties}
                    data-turn={row.turn}
                    tabIndex={-1}
                  >
                    <span aria-hidden="true" className="trajectory-branch" />
                    {row.hasChildren ? (
                      <button
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${row.label}`}
                        className="trajectory-collapse"
                        onClick={() => setCollapsed((current) => toggledSet(current, row.id))}
                        type="button"
                      >
                        {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      </button>
                    ) : (
                      <span className="trajectory-collapse-spacer" />
                    )}
                    <button
                      aria-pressed={selected}
                      className="trajectory-select"
                      onClick={() => {
                        manualSelectionRef.current = row.sequence;
                        onSelectSequence(row.sequence);
                      }}
                      type="button"
                    >
                      <span className={`trajectory-kind kind-${laneForKind(row.kind)}`}>
                        {kindLabel(row.kind)}
                      </span>
                      <TrajectoryIdentity row={row} />
                      <span
                        className="trajectory-summary"
                        title={row.summary.trim() ? row.summary : undefined}
                      >
                        {row.summary}
                      </span>
                      <span className="trajectory-time">
                        <time dateTime={row.startedAt}>{formatTime(row.startedAt)}</time>
                        <small>{formatDuration(row.durationMs)}</small>
                      </span>
                      <span className="trajectory-state" title={row.status}>
                        <i />
                        <span>{row.status}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function TrajectoryOverview({
  active,
  revealRequest,
  rows,
  selectedSequence,
}: {
  readonly active: boolean;
  readonly revealRequest: number;
  readonly rows: readonly TrajectoryViewRow[];
  readonly selectedSequence?: number | undefined;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const selectedMarkerRef = useRef<HTMLElement>(null);
  const lanes: readonly { readonly key: TrajectoryLane; readonly label: string }[] = [
    { key: "input", label: "Input" },
    { key: "model", label: "Model" },
    { key: "tools", label: "Tools" },
  ];
  const columnCount = Math.max(1, rows.length);
  const trackColumns = `repeat(${columnCount}, ${OVERVIEW_STEP_WIDTH}px)`;
  const trackMinWidth =
    Math.max(1, rows.length) * (OVERVIEW_STEP_WIDTH + OVERVIEW_STEP_GAP) - OVERVIEW_STEP_GAP + 6;

  useEffect(() => {
    const scroll = scrollRef.current;
    const marker = selectedMarkerRef.current;
    if (
      !active ||
      !Number.isSafeInteger(revealRequest) ||
      revealRequest <= 0 ||
      selectedSequence === undefined ||
      scroll === null ||
      marker === null
    ) {
      return;
    }
    const scrollBounds = scroll.getBoundingClientRect();
    const markerBounds = marker.getBoundingClientRect();
    const delta =
      markerBounds.left + markerBounds.width / 2 - (scrollBounds.left + scrollBounds.width / 2);
    if (Math.abs(delta) >= 0.5) {
      scroll.scrollTo({
        behavior: "smooth",
        left: Math.max(0, scroll.scrollLeft + delta),
      });
    }
  }, [active, revealRequest, selectedSequence]);

  return (
    <div className="trajectory-overview">
      <div aria-hidden="true" className="trajectory-overview-labels">
        {lanes.map((lane) => (
          <span key={lane.key}>{lane.label}</span>
        ))}
      </div>
      <section
        aria-label="Trajectory overview"
        className="trajectory-overview-scroll"
        ref={scrollRef}
        tabIndex={rows.length > 0 ? 0 : undefined}
      >
        <TooltipProvider>
          <div className="trajectory-overview-tracks" style={{ minWidth: trackMinWidth }}>
            {lanes.map((lane) => (
              <div
                className="trajectory-overview-track"
                key={lane.key}
                style={{ gridTemplateColumns: trackColumns }}
              >
                {rows.map((row) => {
                  const visible = laneForKind(row.kind) === lane.key;
                  const selected = row.sequence === selectedSequence;
                  const locating = visible && selected && revealRequest > 0;
                  if (!visible) {
                    return <i className="is-empty" key={`${row.id}:${lane.key}`} />;
                  }
                  return (
                    <Tooltip key={`${row.id}:${locating ? revealRequest : 0}`}>
                      <TooltipTrigger asChild>
                        <i
                          aria-label={overviewTooltipLabel(row)}
                          className={`kind-${lane.key}${selected ? " is-selected" : ""}${
                            locating ? " is-locating" : ""
                          } status-${row.status}`}
                          ref={selected ? selectedMarkerRef : undefined}
                          role="img"
                        />
                      </TooltipTrigger>
                      <TooltipContent align="center" side="top" sideOffset={7}>
                        <div className="trajectory-overview-tooltip">
                          <strong>{row.label}</strong>
                          <code>{row.atomKey}</code>
                          <dl>
                            <div>
                              <dt>Started</dt>
                              <dd>{formatTime(row.startedAt)}</dd>
                            </div>
                            <div>
                              <dt>Duration</dt>
                              <dd>{formatDuration(row.durationMs)}</dd>
                            </div>
                          </dl>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ))}
          </div>
        </TooltipProvider>
      </section>
    </div>
  );
}

function overviewTooltipLabel(row: TrajectoryViewRow): string {
  return `${row.label} · ${formatTime(row.startedAt)} · ${formatDuration(row.durationMs)}`;
}

function TrajectoryIdentity({ row }: { readonly row: TrajectoryViewRow }) {
  return (
    <span className="trajectory-identity">
      <strong>{row.label}</strong>
      <small>
        {row.atomKey}
        {row.turn !== undefined ? ` · turn ${row.turn}` : ""}
      </small>
      {row.instanceCount > 1 ? <em>×{row.instanceCount}</em> : null}
    </span>
  );
}

function trajectoryGroups(rows: readonly TrajectoryViewRow[]): readonly {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly TrajectoryViewRow[];
}[] {
  const groups: Array<{
    key: string;
    label: string;
    rows: TrajectoryViewRow[];
  }> = [];
  for (const row of rows) {
    const label = row.turn === undefined ? "Run context" : `Turn ${row.turn}`;
    const current = groups.at(-1);
    if (current?.label === label) {
      current.rows.push(row);
      continue;
    }
    groups.push({
      key: `${label}:${groups.length}`,
      label,
      rows: [row],
    });
  }
  return groups;
}

function laneForKind(kind: TrajectoryViewRow["kind"]): TrajectoryLane {
  switch (kind) {
    case "input":
    case "context":
    case "reply":
    case "run":
      return "input";
    case "action":
    case "agent":
    case "handoff":
    case "loop":
    case "model":
    case "usage":
      return "model";
    default:
      return "tools";
  }
}

function kindLabel(kind: TrajectoryViewRow["kind"]): string {
  switch (kind) {
    case "input":
    case "context":
    case "run":
      return "SYSTEM";
    case "reply":
      return "OUTPUT";
    default:
      return kind.toUpperCase();
  }
}

function toggledSet(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return "running";
  }
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
