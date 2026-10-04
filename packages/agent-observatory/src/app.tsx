import { StudioNavigationDrawer, StudioSlot } from "@yiku/agent-studio/react";
import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import { Boxes, GitBranch, ListTree, Radio, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { announceBrowserPresence, getRun, listRuns } from "./api.js";
import { AtomicLog } from "./components/atomic-log.js";
import { FlowGuide } from "./components/flow-guide.js";
import { MessageInspector } from "./components/message-inspector.js";
import { PanelToggle } from "./components/panel-toggle.js";
import { ReplayControls } from "./components/replay-controls.js";
import { ReplayTimeline } from "./components/replay-timeline.js";
import { RunHistory } from "./components/run-history.js";
import { RuntimeCanvas } from "./components/runtime-canvas.js";
import { TrajectoryView } from "./components/trajectory-view.js";
import { type CanvasView, resolveCanvasView, storeCanvasView } from "./state/canvas-view.js";
import { flowReducer, INITIAL_FLOW_STATE } from "./state/flow-reducer.js";
import {
  selectAtomViews,
  selectEdgeViews,
  selectFlowAtomDefinitions,
  selectFlowEdges,
  selectFunctionalEvents,
  selectObservedAtomKeys,
  selectReplayPosition,
  selectReplaySteps,
  selectSelectedEvent,
  selectVisibleEvents,
} from "./state/flow-selectors.js";
import { panelStateForWidth, togglePanel, updatePanelWidth } from "./state/panel-state.js";
import {
  activeObservedAtomKeys,
  isActiveRunStatus,
  shouldHighlightExecution,
} from "./state/run-activity.js";
import { parseRunDeepLink } from "./state/run-deep-link.js";
import { automaticRunId } from "./state/run-selection.js";
import type { RunDetail, RunSummary } from "./types.js";

const BROWSER_PRESENCE_INTERVAL_MS = 1_000;

export function App() {
  const [deepLink] = useState(() =>
    parseRunDeepLink(typeof window === "undefined" ? "" : window.location.search),
  );
  const [flowState, dispatch] = useReducer(flowReducer, INITIAL_FLOW_STATE);
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetail>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(deepLink.runId);
  const [playing, setPlaying] = useState(false);
  const [canvasView, setCanvasView] = useState<CanvasView>(() =>
    resolveCanvasView(
      typeof window === "undefined" ? "" : window.location.search,
      typeof window === "undefined" ? undefined : window.localStorage,
    ),
  );
  const [locateRequest, setLocateRequest] = useState(0);
  const [trajectoryRevealRequest, setTrajectoryRevealRequest] = useState(0);
  const [error, setError] = useState("");
  const [panels, setPanels] = useState(() =>
    panelStateForWidth(typeof window === "undefined" ? 1440 : window.innerWidth),
  );
  const followLatestRef = useRef(deepLink.runId === undefined);
  const latestSequenceRef = useRef(0);
  const loadedRunIdRef = useRef<string | undefined>(undefined);
  const selectedAgentIdRef = useRef<string | undefined>(undefined);
  const requestedRunIdRef = useRef<string | undefined>(deepLink.runId);
  const selectedRunIdRef = useRef<string | undefined>(deepLink.runId);
  const selectRunRequestRef = useRef(0);
  latestSequenceRef.current = flowState.latestSequence;

  const atomViews = useMemo(() => selectAtomViews(flowState), [flowState]);
  const selectedEvent = useMemo(() => selectSelectedEvent(flowState), [flowState]);
  const selectionHighlighted = shouldHighlightExecution(
    selectedRun?.status,
    selectedEvent,
    flowState.live,
  );
  const executionActive = flowState.live && selectionHighlighted;
  const edgeViews = useMemo(
    () => selectEdgeViews(flowState, executionActive, selectionHighlighted),
    [executionActive, flowState, selectionHighlighted],
  );
  const flowAtomDefinitions = useMemo(() => selectFlowAtomDefinitions(flowState), [flowState]);
  const flowEdges = useMemo(() => selectFlowEdges(flowState), [flowState]);
  const observedAtomKeys = useMemo(
    () => activeObservedAtomKeys(selectObservedAtomKeys(flowState), executionActive),
    [executionActive, flowState],
  );
  const orderedEvents = useMemo(() => selectFunctionalEvents(flowState), [flowState]);
  const trajectoryEvents = useMemo(() => selectVisibleEvents(flowState), [flowState]);
  const replaySteps = useMemo(() => selectReplaySteps(flowState), [flowState]);
  const eventPosition = useMemo(
    () => selectReplayPosition(flowState, replaySteps),
    [flowState, replaySteps],
  );

  useEffect(() => {
    let frame = 0;
    const handleResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setPanels((current) => updatePanelWidth(current, window.innerWidth));
      });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    const announce = () => {
      void announceBrowserPresence().catch(() => undefined);
    };
    announce();
    const timer = window.setInterval(announce, BROWSER_PRESENCE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const refreshRuns = useCallback(async () => {
    const nextRuns = await listRuns();
    setRuns(nextRuns);
    return nextRuns;
  }, []);

  const selectRun = useCallback(async (runId: string, manual = false, agentId?: string) => {
    if (manual) {
      followLatestRef.current = false;
      requestedRunIdRef.current = undefined;
    }
    selectedAgentIdRef.current = agentId;
    setSelectedAgentId(agentId);
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
    const requestId = selectRunRequestRef.current + 1;
    selectRunRequestRef.current = requestId;
    setPlaying(false);
    let detail: RunDetail;
    try {
      detail = await getRun(runId);
    } catch (cause) {
      if (requestId === selectRunRequestRef.current) {
        selectedRunIdRef.current = loadedRunIdRef.current;
        setSelectedRunId(loadedRunIdRef.current);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    if (requestId !== selectRunRequestRef.current) {
      return;
    }
    loadedRunIdRef.current = detail.runId;
    setError("");
    setSelectedRun(detail);
    dispatch({ events: detail.events, type: "load" });
    const agentEvent =
      agentId === undefined
        ? undefined
        : detail.events.find(
            (event) =>
              event.atom.key === "subagent.lifecycle" &&
              event.phase === "start" &&
              event.payload?.values?.agentId === agentId,
          );
    if (agentEvent !== undefined) {
      dispatch({ sequence: agentEvent.sequence, type: "select" });
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshRuns().catch((cause: unknown) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    const timer = window.setInterval(() => {
      void refreshRuns().catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    }, 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshRuns]);

  useEffect(() => {
    const summary = runs.find((run) => run.runId === selectedRun?.runId);
    if (
      summary !== undefined &&
      selectedRun !== undefined &&
      (summary.status !== selectedRun.status ||
        summary.eventCount !== selectedRun.eventCount ||
        summary.updatedAt !== selectedRun.updatedAt)
    ) {
      setSelectedRun({
        ...selectedRun,
        ...summary,
      });
    }
  }, [runs, selectedRun]);

  useEffect(() => {
    const requestedRunId = requestedRunIdRef.current;
    if (requestedRunId !== undefined) {
      if (
        loadedRunIdRef.current !== requestedRunId &&
        runs.some((run) => run.runId === requestedRunId)
      ) {
        void selectRun(requestedRunId);
      }
      return;
    }
    const runId = automaticRunId(runs, selectedRunIdRef.current, followLatestRef.current);
    if (runId !== undefined) {
      void selectRun(runId);
    }
  }, [runs, selectRun]);

  useEffect(() => {
    if (selectedRun === undefined || !isActiveRunStatus(selectedRun.status)) {
      return;
    }
    let active = true;
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(selectedRun.runId)}/events?after=${latestSequenceRef.current}`,
    );
    const receive = (message: MessageEvent<string>) => {
      dispatch({
        event: JSON.parse(message.data) as AtomicFlowEvent,
        type: "receive",
      });
    };
    source.addEventListener("atomic-flow", receive as EventListener);
    source.onerror = () => {
      source.close();
      if (!active || selectedRunIdRef.current !== selectedRun.runId) {
        return;
      }
      void selectRun(selectedRun.runId, false, selectedAgentIdRef.current).then(refreshRuns);
    };
    return () => {
      active = false;
      source.close();
    };
  }, [refreshRuns, selectRun, selectedRun]);

  const handleSeek = useCallback(
    (position: number) => {
      const step = replaySteps[position - 1];
      if (step !== undefined) {
        dispatch({ sequence: step.replaySequence, type: "seek" });
      }
    },
    [replaySteps],
  );
  const handleSelectSequence = useCallback((sequence: number) => {
    setPlaying(false);
    dispatch({ sequence, type: "select" });
  }, []);
  const handleHighlightSequence = useCallback((sequence: number) => {
    dispatch({ sequence, type: "highlight" });
    setTrajectoryRevealRequest((current) => current + 1);
  }, []);
  const handleCanvasViewChange = useCallback((view: CanvasView) => {
    setCanvasView(view);
    storeCanvasView(view, window.localStorage);
  }, []);
  const returnToLatest = useCallback(() => {
    setPlaying(false);
    dispatch({ type: "live" });
  }, []);
  const locateCurrent = useCallback(() => {
    returnToLatest();
    setLocateRequest((current) => current + 1);
  }, [returnToLatest]);

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand">
          <span className="brand-mark">
            <Boxes size={15} />
          </span>
          <div className="studio-brand-copy">
            <strong>Yiku Agent Observatory</strong>
            <small>LOCAL RUNTIME INTELLIGENCE</small>
          </div>
          <StudioNavigationDrawer />
        </div>
        <div className="observer-banner">
          <Radio size={15} />
          <div>
            <span className="eyebrow">
              {selectedRun?.kind === "control" ? "CONTROL RUN STREAM" : "AGENT EVENT STREAM"}
            </span>
            <strong>
              {selectedRun === undefined
                ? "Waiting for a Yiku CLI run"
                : `${selectedRun.kind === "control" ? "Control" : "Agent"} · ${
                    selectedRun.projectName ?? "Local workspace"
                  } · ${selectedRun.eventCount} events`}
            </strong>
          </div>
        </div>
        <div className="studio-header-actions">
          <StudioSlot slot="header.actions" />
          <div
            aria-live="polite"
            className={`run-status status-${selectedRun?.status ?? "idle"}`}
            role="status"
          >
            <span aria-hidden="true" className="status-dot" />
            {selectedRun?.status ?? "idle"}
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section
        className={`studio-workspace${panels.leftExpanded ? "" : " is-left-collapsed"}${
          panels.rightExpanded ? "" : " is-right-collapsed"
        }`}
        onTransitionEnd={(event) => {
          if (event.propertyName === "grid-template-columns") {
            window.dispatchEvent(new Event("resize"));
          }
        }}
      >
        <aside className="history-column">
          <PanelToggle
            expanded={panels.leftExpanded}
            onToggle={() => setPanels((current) => togglePanel(current, "left"))}
            side="left"
          />
          {panels.leftExpanded ? (
            <RunHistory
              onSelect={(runId, agentId) => void selectRun(runId, true, agentId)}
              runs={runs}
              selectedAgentId={selectedAgentId}
              selectedRunId={selectedRunId}
            />
          ) : (
            <span className="panel-rail-label">RUNS</span>
          )}
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div className="toolbar-summary">
              <span className="eyebrow">
                {canvasView === "topology" ? "EXECUTION TOPOLOGY" : "RUN TRAJECTORY"}
              </span>
              <strong>
                {flowState.live ? "Live execution" : `Replay #${flowState.replaySequence}`}
              </strong>
            </div>
            <div className="toolbar-actions">
              <fieldset aria-label="Canvas view" className="canvas-view-switch">
                <button
                  aria-label="Show topology view"
                  aria-pressed={canvasView === "topology"}
                  className={canvasView === "topology" ? "is-active" : ""}
                  onClick={() => handleCanvasViewChange("topology")}
                  type="button"
                >
                  <GitBranch size={12} />
                  <span className="button-label">Topology</span>
                </button>
                <button
                  aria-label="Show trajectory view"
                  aria-pressed={canvasView === "trajectory"}
                  className={canvasView === "trajectory" ? "is-active" : ""}
                  onClick={() => handleCanvasViewChange("trajectory")}
                  type="button"
                >
                  <ListTree size={12} />
                  <span className="button-label">Trajectory</span>
                </button>
              </fieldset>
              <FlowGuide />
              {canvasView === "topology" ? (
                <button
                  className={flowState.deepView ? "is-active" : ""}
                  onClick={() => dispatch({ type: "toggle-deep" })}
                  type="button"
                >
                  <Sparkles size={12} /> <span className="button-label">Deep View</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="runtime-canvas-stack">
            <div
              aria-hidden={canvasView !== "topology"}
              className={`runtime-view-layer${canvasView === "topology" ? " is-active" : ""}`}
            >
              <RuntimeCanvas
                atomDefinitions={flowAtomDefinitions}
                atomViews={atomViews}
                deepView={flowState.deepView}
                edges={flowEdges}
                edgeViews={edgeViews}
                executionActive={executionActive}
                layoutReady={selectedRun !== undefined && canvasView === "topology"}
                layoutKey={`${panels.leftExpanded}:${panels.rightExpanded}`}
                locateAtomKey={selectedEvent?.atom.key}
                locateRequest={locateRequest}
                onSelectSequence={handleSelectSequence}
                observedAtomKeys={observedAtomKeys}
                selectedEvent={selectionHighlighted ? selectedEvent : undefined}
              />
            </div>
            <div
              aria-hidden={canvasView !== "trajectory"}
              className={`runtime-view-layer${canvasView === "trajectory" ? " is-active" : ""}`}
            >
              <TrajectoryView
                active={canvasView === "trajectory"}
                events={trajectoryEvents}
                followActive={flowState.live}
                key={selectedRun?.runId ?? "empty"}
                locateRequest={locateRequest}
                onBack={returnToLatest}
                onLocateCurrent={locateCurrent}
                onSelectSequence={handleHighlightSequence}
                overviewRevealRequest={locateRequest + trajectoryRevealRequest}
                replaySequence={flowState.replaySequence}
                selectedSequence={flowState.selectedSequence}
              />
            </div>
          </div>
          <footer className="timeline-footer">
            <ReplayControls
              eventCount={replaySteps.length}
              eventPosition={eventPosition}
              live={flowState.live}
              onLive={() => {
                setPlaying(false);
                dispatch({ type: "live" });
              }}
              onPlayingChange={setPlaying}
              onSeek={handleSeek}
              playing={playing}
            />
            <ReplayTimeline
              eventCount={replaySteps.length}
              eventPosition={eventPosition}
              onSeek={handleSeek}
            />
          </footer>
        </section>

        <aside className="log-column">
          <PanelToggle
            expanded={panels.rightExpanded}
            onToggle={() => setPanels((current) => togglePanel(current, "right"))}
            side="right"
          />
          {panels.rightExpanded ? (
            <>
              <AtomicLog
                events={orderedEvents}
                followActive={flowState.live}
                locateRequest={locateRequest + trajectoryRevealRequest}
                onLocateCurrent={locateCurrent}
                onSelect={(sequence) =>
                  sequence === undefined
                    ? dispatch({ type: "clear-selection" })
                    : handleSelectSequence(sequence)
                }
                playing={playing}
                selectedSequence={flowState.selectedSequence}
              />
              <MessageInspector event={selectedEvent} events={orderedEvents} run={selectedRun} />
            </>
          ) : (
            <span className="panel-rail-label">EVENTS</span>
          )}
        </aside>
      </section>
    </main>
  );
}
