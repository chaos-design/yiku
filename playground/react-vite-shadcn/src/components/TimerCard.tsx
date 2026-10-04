import { Check, Edit3, Gauge, Pause, Play, RotateCcw, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useGlobalShortcuts, useScopeActive } from "@/lib/keyboard";

const TIMER_SCOPE = "timer";

const PRESET_DURATIONS = [
  { label: "1分", seconds: 60 },
  { label: "3分", seconds: 180 },
  { label: "5分", seconds: 300 },
];

const CUSTOM_PRESET_INDEX = -1;

function formatTime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return {
    hours: String(hours).padStart(2, "0"),
    minutes: String(minutes).padStart(2, "0"),
    seconds: String(seconds).padStart(2, "0"),
  };
}

export function TimerCard() {
  const [presetIndex, setPresetIndex] = useState(0);
  const [customSeconds, setCustomSeconds] = useState(60);
  const [inputHours, setInputHours] = useState("00");
  const [inputMinutes, setInputMinutes] = useState("01");
  const [inputSeconds, setInputSeconds] = useState("00");
  const [remaining, setRemaining] = useState(PRESET_DURATIONS[0].seconds);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const timerRef = useRef<number | null>(null);

  const isCustom = presetIndex === CUSTOM_PRESET_INDEX;
  const totalSeconds = isCustom ? customSeconds : PRESET_DURATIONS[presetIndex].seconds;
  const { hours, minutes, seconds } = formatTime(remaining);
  const showHours = parseInt(hours, 10) > 0 || isCustom;
  const progress = totalSeconds > 0 ? (totalSeconds - remaining) / totalSeconds : 0;

  useEffect(() => {
    if (running) {
      timerRef.current = window.setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            setRunning(false);
            setFinished(true);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [running]);

  const resetTimer = useCallback(() => {
    setRunning(false);
    setFinished(false);
    setRemaining(totalSeconds);
  }, [totalSeconds]);

  /**
   * Start / pause the timer. When the timer has already reached zero, a single
   * click must reset `remaining` and `finished` synchronously before flipping
   * `running` to true; otherwise the interval effect runs with the stale 0
   * value and immediately re-triggers completion.
   */
  const toggleRunning = useCallback(() => {
    if (finished) {
      setRemaining(totalSeconds);
      setFinished(false);
      // Defer start until React has flushed the reset so the next effect run
      // sees the fresh total and not the stale zero.
      setRunning(true);
      return;
    }
    if (!running && remaining === 0) {
      setRemaining(totalSeconds);
      setRunning(true);
      return;
    }
    setRunning((v) => !v);
  }, [finished, running, remaining, totalSeconds]);

  const cyclePreset = () => {
    if (isCustom) {
      // 从自定义切到第一个预设
      setPresetIndex(0);
      setRemaining(PRESET_DURATIONS[0].seconds);
      setFinished(false);
      return;
    }
    setPresetIndex((i) => {
      const next = (i + 1) % PRESET_DURATIONS.length;
      setRemaining(PRESET_DURATIONS[next].seconds);
      setFinished(false);
      return next;
    });
  };

  const handlePresetChange = (index: number) => {
    setPresetIndex(index);
    setRemaining(PRESET_DURATIONS[index].seconds);
    setRunning(false);
    setFinished(false);
  };

  const applyCustomDuration = useCallback(() => {
    const hrs = Math.max(0, Math.min(99, parseInt(inputHours, 10) || 0));
    const mins = Math.max(0, Math.min(59, parseInt(inputMinutes, 10) || 0));
    const secs = Math.max(0, Math.min(59, parseInt(inputSeconds, 10) || 0));
    const total = hrs * 3600 + mins * 60 + secs;
    if (total <= 0) return;
    // 将输入框中的值归一化为补零后的字符串，确保"5分" -> "05"
    setInputHours(String(hrs).padStart(2, "0"));
    setInputMinutes(String(mins).padStart(2, "0"));
    setInputSeconds(String(secs).padStart(2, "0"));
    setCustomSeconds(total);
    setPresetIndex(CUSTOM_PRESET_INDEX);
    setRemaining(total);
    setRunning(false);
    setFinished(false);
  }, [inputHours, inputMinutes, inputSeconds]);

  const handleCustomKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCustomDuration();
      (e.currentTarget as HTMLInputElement).blur();
    }
  };

  // 键盘快捷键：空格=开始/暂停（已结束则重新开始），R=重置，T=切换预设
  const scopeActive = useScopeActive(TIMER_SCOPE);
  useGlobalShortcuts(
    (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        toggleRunning();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        resetTimer();
      } else if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        if (!running) cyclePreset();
      }
    },
    [toggleRunning, resetTimer, running],
    { enabled: scopeActive },
  );

  const digitColor = finished ? "text-destructive" : "text-orange-500";

  return (
    <Card className="border-orange-400/40 bg-orange-400/5 shadow-lg shadow-orange-400/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-orange-500" />
          倒计时器
        </CardTitle>
        <CardDescription>选择预设时长，支持开始 / 暂停 / 重置，归零即提示</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 数字展示区 */}
        <div
          className={
            "relative flex flex-col items-center gap-3 overflow-hidden rounded-xl border p-6 shadow-sm transition-all duration-300 " +
            (finished
              ? "border-destructive bg-destructive/10 animate-pulse"
              : running
                ? "border-orange-400/60 bg-orange-400/10"
                : "border-orange-400/30 bg-background/80")
          }
        >
          {/* 进度条 */}
          <div
            className="absolute inset-x-0 bottom-0 h-2 bg-gradient-to-r from-orange-500 to-orange-400 shadow-[0_0_12px_rgba(249,115,22,0.6)] transition-all duration-1000 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />

          <span className="text-xs font-medium text-muted-foreground">剩余时间</span>

          <div className="flex items-end gap-1 font-mono text-6xl font-bold tabular-nums sm:text-7xl">
            {showHours && (
              <>
                <span className={digitColor}>
                  <AnimatedNumber
                    value={parseInt(hours, 10)}
                    duration={running ? 200 : 500}
                    format={(v) => String(Math.round(v)).padStart(2, "0")}
                  />
                </span>
                <span className={digitColor}>:</span>
              </>
            )}
            <span className={digitColor}>
              <AnimatedNumber
                value={parseInt(minutes, 10)}
                duration={running ? 200 : 500}
                format={(v) => String(Math.round(v)).padStart(2, "0")}
              />
            </span>
            <span className={digitColor}>:</span>
            <span className={digitColor}>
              <AnimatedNumber
                value={parseInt(seconds, 10)}
                duration={running ? 200 : 500}
                format={(v) => String(Math.round(v)).padStart(2, "0")}
              />
            </span>
          </div>

          {finished && (
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <Timer className="h-4 w-4" />
              时间到！
            </div>
          )}
        </div>

        {/* 预设时长 & 自定义时长 */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-orange-400/30 bg-orange-400/5 px-2.5 py-2.5 sm:w-44">
            <Gauge className="hidden h-3.5 w-3.5 shrink-0 text-orange-600 lg:block" />
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {PRESET_DURATIONS.map((p, i) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={presetIndex === i ? "default" : "secondary"}
                  onClick={() => handlePresetChange(i)}
                  disabled={running}
                  className="h-8 flex-1 px-2 text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg border border-orange-400/30 bg-orange-400/5 px-3 py-2.5">
            <Edit3 className="h-4 w-4 shrink-0 text-orange-600" />
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
              <input
                type="number"
                min={0}
                max={99}
                value={inputHours}
                onChange={(e) => setInputHours(e.target.value)}
                onBlur={applyCustomDuration}
                onKeyDown={handleCustomKeyDown}
                disabled={running}
                aria-label="小时"
                className="h-9 w-12 rounded-lg border-2 border-orange-300/50 bg-background px-1 text-center font-mono text-base font-bold tabular-nums text-orange-600 shadow-sm transition-all duration-200 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-500/20 hover:border-orange-400/70 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="text-xl font-bold text-orange-500">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={inputMinutes}
                onChange={(e) => setInputMinutes(e.target.value)}
                onBlur={applyCustomDuration}
                onKeyDown={handleCustomKeyDown}
                disabled={running}
                aria-label="分钟"
                className="h-9 w-12 rounded-lg border-2 border-orange-300/50 bg-background px-1 text-center font-mono text-base font-bold tabular-nums text-orange-600 shadow-sm transition-all duration-200 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-500/20 hover:border-orange-400/70 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="text-xl font-bold text-orange-500">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={inputSeconds}
                onChange={(e) => setInputSeconds(e.target.value)}
                onBlur={applyCustomDuration}
                onKeyDown={handleCustomKeyDown}
                disabled={running}
                aria-label="秒"
                className="h-9 w-12 rounded-lg border-2 border-orange-300/50 bg-background px-1 text-center font-mono text-base font-bold tabular-nums text-orange-600 shadow-sm transition-all duration-200 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-500/20 hover:border-orange-400/70 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                size="sm"
                variant={isCustom ? "default" : "outline"}
                onClick={applyCustomDuration}
                disabled={running}
                className="ml-1 h-9 w-9 p-0"
                title="应用自定义时长"
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* 控制条 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-orange-400/40 bg-orange-400/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-orange-600">
            <Timer className={`h-4 w-4 ${running ? "animate-pulse" : ""}`} />
            {running ? "计时中…" : finished ? "已结束" : "待开始"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={resetTimer}
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
                  {finished ? "重新开始" : "开始"}
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default TimerCard;
