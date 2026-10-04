import { Pause, Play, Radio, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";

interface ReplayControlsProps {
  readonly eventCount: number;
  readonly eventPosition: number;
  readonly live: boolean;
  readonly onLive: () => void;
  readonly onPlayingChange: (playing: boolean) => void;
  readonly onSeek: (position: number) => void;
  readonly playing: boolean;
}

export function ReplayControls({
  eventCount,
  eventPosition,
  live,
  onLive,
  onPlayingChange,
  onSeek,
  playing,
}: ReplayControlsProps) {
  const [speed, setSpeed] = useState(1);
  const hasEvents = eventCount > 0;

  useEffect(() => {
    if (!playing) {
      return;
    }
    if (eventPosition >= eventCount) {
      onPlayingChange(false);
      return;
    }
    const timer = window.setTimeout(() => {
      onSeek(Math.min(eventCount, eventPosition + 1));
    }, 700 / speed);
    return () => window.clearTimeout(timer);
  }, [eventCount, eventPosition, onPlayingChange, onSeek, playing, speed]);

  return (
    <div className="replay-controls">
      <button
        aria-label="Replay from first event"
        data-tooltip="Replay from start"
        disabled={!hasEvents}
        onClick={() => {
          onSeek(1);
          onPlayingChange(eventCount > 1);
        }}
        type="button"
      >
        <RotateCcw size={13} />
      </button>
      <button
        aria-label="Previous event"
        data-tooltip="Previous event"
        disabled={!hasEvents}
        onClick={() => onSeek(Math.max(1, eventPosition - 1))}
        type="button"
      >
        <SkipBack size={13} />
      </button>
      <button
        aria-label={playing ? "Pause replay" : "Play replay"}
        className={playing ? "is-active" : ""}
        data-tooltip={playing ? "Pause replay" : "Play replay"}
        disabled={!hasEvents}
        onClick={() => onPlayingChange(!playing)}
        type="button"
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button
        aria-label="Next event"
        data-tooltip="Next event"
        disabled={!hasEvents}
        onClick={() => onSeek(Math.min(eventCount, eventPosition + 1))}
        type="button"
      >
        <SkipForward size={13} />
      </button>
      <button
        aria-label={`Replay speed: ${speed}×`}
        disabled={!hasEvents}
        onClick={() => setSpeed((value) => (value >= 4 ? 0.5 : value * 2))}
        title={`Replay speed: ${speed}×`}
        type="button"
      >
        {speed}×
      </button>
      <button
        aria-label="Follow live events"
        className={live ? "is-live" : ""}
        onClick={onLive}
        title="Follow live events"
        type="button"
      >
        <Radio size={12} />
        Live
      </button>
    </div>
  );
}
