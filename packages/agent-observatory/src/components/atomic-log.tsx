import { type AtomicFlowEvent, isTraceObservationEvent } from "@yiku/atomic-flow/browser";
import { ChevronDown, ChevronUp, LocateFixed, Search } from "lucide-react";
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createEventTurnIndex } from "../state/event-turn.js";

interface AtomicLogProps {
  readonly events: readonly AtomicFlowEvent[];
  readonly followActive?: boolean | undefined;
  readonly locateRequest?: number | undefined;
  readonly onLocateCurrent?: (() => void) | undefined;
  readonly onSelect: (sequence: number | undefined) => void;
  readonly playing: boolean;
  readonly selectedSequence?: number | undefined;
}

export interface LogScrollState {
  readonly canScrollDown: boolean;
  readonly canScrollUp: boolean;
}

const EMPTY_LOG_SCROLL_STATE: LogScrollState = {
  canScrollDown: false,
  canScrollUp: false,
};

export function AtomicLog({
  events,
  followActive = false,
  locateRequest = 0,
  onLocateCurrent,
  onSelect,
  playing,
  selectedSequence,
}: AtomicLogProps) {
  const [scrollRequest, setScrollRequest] = useState(0);
  const [query, setQuery] = useState("");
  const [scrollState, setScrollState] = useState(EMPTY_LOG_SCROLL_STATE);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const followingRef = useRef(true);
  const locateRequestRef = useRef(locateRequest);
  const runIdRef = useRef<string | undefined>(undefined);
  const runId = events[0]?.runId;
  const turnIndex = useMemo(() => createEventTurnIndex(events), [events]);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const filteredEvents = useMemo(() => {
    const logEvents = events.filter(isLogEvent);
    const matchedEvents = deferredQuery
      ? logEvents.filter((event) => eventSearchText(event).includes(deferredQuery))
      : logEvents;
    return matchedEvents.toReversed();
  }, [deferredQuery, events]);
  const turnMarkerSequences = useMemo(() => {
    const markerByTurn = new Map<number, number>();
    for (const event of filteredEvents) {
      const turn = turnIndex.bySequence.get(event.sequence);
      if (turn !== undefined) {
        markerByTurn.set(turn, event.sequence);
      }
    }
    return new Set(markerByTurn.values());
  }, [filteredEvents, turnIndex]);

  useEffect(() => {
    if (runIdRef.current !== runId) {
      runIdRef.current = runId;
      followingRef.current = true;
    }
  }, [runId]);

  useEffect(() => {
    if (locateRequestRef.current === locateRequest) {
      return;
    }
    locateRequestRef.current = locateRequest;
    followingRef.current = true;
    setQuery("");
    setScrollRequest((current) => current + 1);
  }, [locateRequest]);

  useEffect(() => {
    if ((!followActive && !playing) || selectedSequence === undefined || !followingRef.current) {
      return;
    }
    selectedRowRef.current?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
    });
  }, [followActive, playing, selectedSequence]);

  useEffect(() => {
    if (
      scrollRequest === 0 ||
      selectedSequence === undefined ||
      !filteredEvents.some((event) => event.sequence === selectedSequence)
    ) {
      return;
    }
    selectedRowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [filteredEvents, scrollRequest, selectedSequence]);

  const locateSelected = useCallback(() => {
    followingRef.current = true;
    setQuery("");
    setScrollRequest((current) => current + 1);
    onLocateCurrent?.();
  }, [onLocateCurrent]);

  const updateScrollState = useCallback(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const next = logScrollState(list);
    setScrollState((current) =>
      current.canScrollDown === next.canScrollDown && current.canScrollUp === next.canScrollUp
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  });

  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(list);
    return () => observer.disconnect();
  }, [updateScrollState]);

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    const selectedRow = selectedRowRef.current;
    if (list !== null && selectedRow !== null) {
      followingRef.current = isVisible(selectedRow, list);
    }
    updateScrollState();
  }, [updateScrollState]);

  return (
    <section className="atomic-log">
      <header className="panel-header">
        <span className="atomic-log-heading">
          <span className="eyebrow">LOG</span>
          <button
            aria-label="Locate current running node"
            className="locate-current-button"
            disabled={selectedSequence === undefined}
            onClick={locateSelected}
            title="Locate current running node"
            type="button"
          >
            <LocateFixed size={13} />
          </button>
        </span>
        <label className="atomic-log-search">
          <Search aria-hidden="true" size={13} />
          <input
            aria-label="Search atomic log"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools or text"
            type="search"
            value={query}
          />
        </label>
      </header>
      <div className="atomic-log-scroll-area">
        {scrollState.canScrollUp ? (
          <button
            aria-label="Scroll atomic log to top"
            className="log-scroll-button is-top"
            onClick={() => listRef.current?.scrollTo({ behavior: "smooth", top: 0 })}
            title="Scroll to top"
            type="button"
          >
            <ChevronUp size={14} />
          </button>
        ) : null}
        <div className="atomic-log-list" onScroll={handleScroll} ref={listRef}>
          {filteredEvents.map((event) => {
            const occurredAt = formatEventTime(event.occurredAt);
            const selected = selectedSequence === event.sequence;
            const turn = turnIndex.bySequence.get(event.sequence);
            return (
              <Fragment key={event.eventId}>
                <button
                  aria-pressed={selected}
                  className={`atomic-log-row${selected ? " is-selected" : ""}${
                    event.internal === true ? " is-internal" : ""
                  }`}
                  onClick={() => {
                    followingRef.current = true;
                    onSelect(nextLogSelection(selectedSequence, event.sequence));
                  }}
                  ref={selected ? selectedRowRef : undefined}
                  type="button"
                >
                  <span className="log-sequence">#{String(event.sequence).padStart(3, "0")}</span>
                  <i className={`phase-dot phase-${event.phase}`} />
                  <strong>{event.atom.key}</strong>
                  <time dateTime={event.occurredAt} title={event.occurredAt}>
                    <span>{occurredAt.date}</span>
                    <span>{occurredAt.time}</span>
                  </time>
                  <small>
                    <span className="log-phase">{event.phase}</span>
                    {event.payload?.summary ?? event.atom.label}
                  </small>
                </button>
                {turn !== undefined && turnMarkerSequences.has(event.sequence) ? (
                  <div className="log-turn-marker">
                    <span>turn {turn}</span>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {filteredEvents.length === 0 ? (
            <output className="atomic-log-empty">No matching events</output>
          ) : null}
        </div>
        {scrollState.canScrollDown ? (
          <button
            aria-label="Scroll atomic log to bottom"
            className="log-scroll-button is-bottom"
            onClick={() =>
              listRef.current?.scrollTo({
                behavior: "smooth",
                top: listRef.current.scrollHeight,
              })
            }
            title="Scroll to bottom"
            type="button"
          >
            <ChevronDown size={14} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function nextLogSelection(
  selectedSequence: number | undefined,
  clickedSequence: number,
): number | undefined {
  return selectedSequence === clickedSequence ? undefined : clickedSequence;
}

export function logScrollState(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): LogScrollState {
  const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  return {
    canScrollDown: maximumScrollTop - element.scrollTop > 1,
    canScrollUp: element.scrollTop > 1,
  };
}

export function isLogEvent(event: AtomicFlowEvent): boolean {
  return !isTraceObservationEvent(event);
}

export function eventSearchText(event: AtomicFlowEvent): string {
  return [
    event.atom.key,
    event.atom.kind,
    event.atom.label,
    event.atom.level,
    event.phase,
    event.payload?.code,
    event.payload?.summary,
    event.payload?.title,
    event.payload?.counts === undefined ? undefined : JSON.stringify(event.payload.counts),
    event.payload?.values === undefined ? undefined : JSON.stringify(event.payload.values),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

export function formatEventTime(occurredAt: string): {
  readonly date: string;
  readonly time: string;
} {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return {
      date: occurredAt,
      time: "",
    };
  }
  return {
    date: `${date.getFullYear()}-${padTime(date.getMonth() + 1)}-${padTime(date.getDate())}`,
    time: `${padTime(date.getHours())}:${padTime(date.getMinutes())}:${padTime(date.getSeconds())}.${padTime(date.getMilliseconds())}`,
  };
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}

function isVisible(element: HTMLElement, container: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom;
}
