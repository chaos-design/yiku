import { Flag, Pause, Play, RotateCcw, TimerReset } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useGlobalShortcuts, useScopeActive } from "@/lib/keyboard";

const STOPWATCH_SCOPE = "stopwatch";

interface Lap {
  index: number;
  /** 该圈用时（毫秒） */
  split: number;
  /** 从开始到该圈结束的总时间（毫秒） */
  total: number;
}

/** 把毫秒格式化为 hh:mm:ss.cs（时:分:秒.厘秒） */
function formatElapsed(ms: number) {
  const totalCs = Math.floor(ms / 10);
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number, len = 2) => String(n).padStart(len, "0");

  return {
    major: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
    minor: pad(cs),
  };
}

/** 把相对首圈的差距（毫秒，非负）格式化为 +hh:mm:ss.cs */
function formatDelta(ms: number) {
  const { major, minor } = formatElapsed(ms);
  return { sign: ms > 0 ? "+" : "", major, minor, isZero: ms === 0 };
}

export function StopwatchCard() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [laps, setLaps] = useState<Lap[]>([]);

  // 使用 ref 保存起始时间戳和累积已过时间，避免 setInterval 漂移
  const startTimestampRef = useRef<number | null>(null);
  const baseElapsedRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;

    startTimestampRef.current = performance.now();

    const tick = () => {
      const now = performance.now();
      const startedAt = startTimestampRef.current ?? now;
      setElapsed(baseElapsedRef.current + (now - startedAt));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [running]);

  const toggleRunning = useCallback(() => {
    setRunning((v) => {
      if (!v) {
        // 即将开始：基准值就是当前 elapsed
        baseElapsedRef.current = elapsed;
        startTimestampRef.current = null;
      } else {
        // 即将暂停：固化当前 elapsed 作为下次的基准
        baseElapsedRef.current = elapsed;
      }
      return !v;
    });
  }, [elapsed]);

  const recordLap = useCallback(() => {
    if (!running) return;
    setLaps((prev) => {
      const prevTotal = prev.length > 0 ? prev[prev.length - 1].total : 0;
      const split = elapsed - prevTotal;
      return [...prev, { index: prev.length + 1, split: Math.max(0, split), total: elapsed }];
    });
  }, [running, elapsed]);

  const reset = useCallback(() => {
    setRunning(false);
    setElapsed(0);
    baseElapsedRef.current = 0;
    startTimestampRef.current = null;
    setLaps([]);
  }, []);

  // 键盘快捷键：空格=开始/暂停，L=计圈，R=重置
  const scopeActive = useScopeActive(STOPWATCH_SCOPE);
  useGlobalShortcuts(
    (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        toggleRunning();
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        recordLap();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        reset();
      }
    },
    [toggleRunning, recordLap, reset],
    { enabled: scopeActive },
  );

  const { major, minor } = formatElapsed(elapsed);

  return (
    <Card
      className="border-sky-400/40 bg-sky-400/5 shadow-lg shadow-sky-400/10"
      data-scope={STOPWATCH_SCOPE}
      tabIndex={0}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TimerReset className="h-5 w-5 text-sky-500" />
          秒表
        </CardTitle>
        <CardDescription>
          赛车式分段计时:计圈不重置,时间持续累加,从第二名起依次显示与第一名的累计差距
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 数字展示区 */}
        <div
          className={
            "relative flex flex-col items-center gap-3 overflow-hidden rounded-xl border p-6 shadow-sm transition-all duration-300 " +
            (running ? "border-sky-400/60 bg-sky-400/10" : "border-sky-400/30 bg-background/80")
          }
        >
          <span className="text-xs font-medium text-muted-foreground">已用时间</span>

          <div className="flex items-end gap-0.5 font-mono font-bold tabular-nums text-sky-500">
            <span className="text-4xl leading-none sm:text-7xl">{major}</span>
            <span className="pb-1 text-xl leading-none opacity-80 sm:pb-2 sm:text-4xl">
              .{minor}
            </span>
          </div>
        </div>

        {/* 控制条 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-sky-400/40 bg-sky-400/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-sky-600">
            <TimerReset className={`h-4 w-4 ${running ? "animate-pulse" : ""}`} />
            {running ? "计时中…" : laps.length > 0 ? "已暂停" : "待开始"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={recordLap}
              disabled={!running}
              className="h-8 gap-1"
            >
              <Flag className="h-3 w-3" />
              计圈
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={reset}
              disabled={elapsed === 0}
              className="h-8 gap-1 text-destructive"
            >
              <RotateCcw className="h-3 w-3" />
              重置
            </Button>
            <Button
              size="sm"
              onClick={toggleRunning}
              className="h-8 gap-1"
              variant={running ? "destructive" : "default"}
            >
              {running ? (
                <>
                  <Pause className="h-3 w-3" />
                  暂停
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  {elapsed > 0 ? "继续" : "开始"}
                </>
              )}
            </Button>
          </div>
        </div>

        {/* 圈数列表 */}
        {laps.length > 0 && (
          <div className="rounded-lg border border-muted-foreground/20 bg-muted/20">
            <div className="grid grid-cols-4 items-center border-b border-muted-foreground/20 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>名次</span>
              <span className="text-center">分段</span>
              <span className="text-center">差距(第一名)</span>
              <span className="text-right">累计时间</span>
            </div>
            <ul className="h-[8.25rem] overflow-y-auto overscroll-contain scroll-smooth [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent">
              {[...laps].reverse().map((lap) => {
                const realIndex = lap.index;
                const firstLap = laps[0];
                const splitStr = formatElapsed(lap.split);
                const totalStr = formatElapsed(lap.total);

                // 第一名差距列留空；之后每名差距 = 该圈累计时间 - 第一名累计时间（始终非负）
                let gapClass = "text-muted-foreground";
                let gapContent: ReactNode = "";
                if (firstLap && realIndex > 1) {
                  const diff = lap.total - firstLap.total;
                  if (diff > 0) {
                    gapClass = "font-semibold text-rose-600";
                  }
                  const { sign, major, minor } = formatDelta(diff);
                  gapContent = `${sign}${major}.${minor}`;
                }

                return (
                  <li
                    key={lap.index}
                    className="grid grid-cols-4 items-center px-4 py-2 font-mono text-sm tabular-nums odd:bg-background/40"
                  >
                    <span className="text-muted-foreground">{realIndex}</span>
                    <span className="text-center">
                      {splitStr.major}.{splitStr.minor}
                    </span>
                    <span className={`text-center ${gapClass}`}>{gapContent}</span>
                    <span className="text-right text-foreground">
                      {totalStr.major}.{totalStr.minor}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default StopwatchCard;
