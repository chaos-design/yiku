interface ReplayTimelineProps {
  readonly eventCount: number;
  readonly eventPosition: number;
  readonly onSeek: (position: number) => void;
}

export function ReplayTimeline({ eventCount, eventPosition, onSeek }: ReplayTimelineProps) {
  const range = eventCount - 1;
  const progress = range <= 0 ? 0 : ((eventPosition - 1) / range) * 100;

  return (
    <label className="replay-timeline">
      <output aria-label="Replay position">
        Event {eventPosition} / {eventCount}
      </output>
      <input
        aria-label="Replay sequence"
        disabled={eventCount === 0}
        max={Math.max(1, eventCount)}
        min={eventCount === 0 ? 0 : 1}
        onChange={(event) => onSeek(Number(event.target.value))}
        type="range"
        value={eventPosition}
      />
      <i style={{ width: `${progress}%` }} />
    </label>
  );
}
