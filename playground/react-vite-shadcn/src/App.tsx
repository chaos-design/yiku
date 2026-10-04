import {
  Calculator,
  Dice5,
  Gauge,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Shuffle,
  Sigma,
  Sparkles,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ScientificCalculatorCard } from "@/components/ScientificCalculatorCard";
import { StopwatchCard } from "@/components/StopwatchCard";
import { TimerCard } from "@/components/TimerCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const RNG_MIN = 1;
const RNG_MAX = 100_000;
const RANDOM_COUNT = 3;
const RANDOM_SLOTS = ["random-a", "random-b", "random-c"] as const;

const RNG_SPEEDS = [
  { label: "慢速", value: 600 },
  { label: "中速", value: 300 },
  { label: "快速", value: 150 },
  { label: "极速", value: 80 },
];

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ──────────────────────────────────────────────
// 累加器组件
// ──────────────────────────────────────────────
const AUTO_SPEEDS = [
  { label: "极慢", value: 2000, step: 1 },
  { label: "慢速", value: 1000, step: 1 },
  { label: "中速", value: 500, step: 1 },
  { label: "快速", value: 200, step: 1 },
  { label: "极速", value: 80, step: 5 },
];

function CounterCard() {
  const [count, setCount] = useState(0);
  const [autoRunning, setAutoRunning] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [step, setStep] = useState(1);
  const timerRef = useRef<number | null>(null);

  const currentSpeed = AUTO_SPEEDS[speedIndex];

  useEffect(() => {
    if (autoRunning) {
      timerRef.current = window.setInterval(() => {
        setCount((c) => c + step);
      }, currentSpeed.value);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [autoRunning, currentSpeed, step]);

  // 键盘快捷键：空格=开始/暂停，R=重置，↑=步进+1，↓=步进-1
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 忽略输入框中的按键
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA"
      )
        return;

      if (e.code === "Space") {
        e.preventDefault();
        setAutoRunning((v) => !v);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        setCount(0);
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        setStep((s) => s + 1);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        setStep((s) => Math.max(1, s - 1));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const toggleAuto = () => setAutoRunning((v) => !v);

  const cycleSpeed = () => {
    setSpeedIndex((i) => (i + 1) % AUTO_SPEEDS.length);
  };

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5 text-primary" />
          累加器
        </CardTitle>
        <CardDescription>支持手动增减与自动累加，可调节速度档位</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 数字展示区 */}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-primary/30 bg-background/60 p-6 shadow-sm">
          <span className="text-xs font-medium text-muted-foreground">当前数值</span>
          <div className="font-mono text-5xl font-bold tabular-nums text-primary sm:text-6xl">
            <AnimatedNumber value={count} duration={500} />
          </div>
        </div>

        {/* 自动累加控制条 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Gauge className="h-4 w-4" />
            自动累加
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={cycleSpeed}
              className="h-8 gap-1 text-xs"
              disabled={autoRunning}
            >
              <Gauge className="h-3 w-3" />
              {currentSpeed.label}
            </Button>
            <Button
              size="sm"
              onClick={toggleAuto}
              className="h-8 gap-1"
              variant={autoRunning ? "destructive" : "default"}
            >
              {autoRunning ? (
                <>
                  <Pause className="h-3 w-3" />
                  暂停
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  开始
                </>
              )}
            </Button>
            <div className="mx-1 h-6 w-px bg-muted-foreground/20" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCount(0)}
              className="h-8 gap-1 text-destructive"
            >
              <RotateCcw className="h-3 w-3" />
              重置
            </Button>
          </div>
        </div>

        {/* 步进值 + 手动增减 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-muted-foreground/20 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sigma className="h-4 w-4" />
            步进值 (Step)
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              className="h-10 w-10 p-0"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <input
              type="number"
              value={step}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v) && v >= 1) setStep(v);
              }}
              min={1}
              className="h-10 w-20 rounded-lg border-2 border-primary/30 bg-background px-3 text-center font-mono text-base font-semibold tabular-nums text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/20 hover:border-primary/50"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setStep((s) => s + 1)}
              className="h-10 w-10 p-0"
            >
              <Plus className="h-5 w-5" />
            </Button>
            <div className="mx-2 h-8 w-px bg-muted-foreground/20" />
            <Button
              size="sm"
              onClick={() => setCount((c) => c - step)}
              className="h-8 w-8 p-0"
              variant="secondary"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setCount((c) => c + step)} className="h-8 w-8 p-0">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────
// 随机数卡片 — 生成 3 个数字，全部生成后自动求和
// ──────────────────────────────────────────────
function RandomCard() {
  const [values, setValues] = useState<number[]>(() =>
    Array.from({ length: RANDOM_COUNT }, () => 0),
  );
  const [rolling, setRolling] = useState(false);
  const [rollSpeedIndex, setRollSpeedIndex] = useState(0);
  const rollSpeed = RNG_SPEEDS[rollSpeedIndex].value;
  const rollTimerRef = useRef<number | null>(null);
  const sum = values.reduce((a, b) => a + b, 0);

  const regenerateAll = useCallback(() => {
    if (rolling) return;
    setValues(Array.from({ length: RANDOM_COUNT }, () => randInt(RNG_MIN, RNG_MAX)));
  }, [rolling]);

  // 滚动时每帧更新所有数字
  useEffect(() => {
    if (rolling) {
      rollTimerRef.current = window.setInterval(() => {
        setValues(Array.from({ length: RANDOM_COUNT }, () => randInt(RNG_MIN, RNG_MAX)));
      }, rollSpeed);
    }
    return () => {
      if (rollTimerRef.current) {
        clearInterval(rollTimerRef.current);
        rollTimerRef.current = null;
      }
    };
  }, [rolling, rollSpeed]);

  // 键盘快捷键：空格=开始/停止，R=全部重新生成，S=切换速度
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA"
      )
        return;

      if (e.code === "Space") {
        e.preventDefault();
        setRolling((v) => !v);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        regenerateAll();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        setRollSpeedIndex((i) => (i + 1) % RNG_SPEEDS.length);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [regenerateAll]);

  const regenerate = (index: number) => {
    if (rolling) return;
    setValues((prev) => {
      const next = [...prev];
      next[index] = randInt(RNG_MIN, RNG_MAX);
      return next;
    });
  };

  const toggleRoll = () => setRolling((v) => !v);

  return (
    <Card className="border-accent/40 bg-accent/5 shadow-lg shadow-accent/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Dice5 className="h-5 w-5 text-accent-foreground" />
          随机数
        </CardTitle>
        <CardDescription>
          在 {RNG_MIN.toLocaleString()} ~ {RNG_MAX.toLocaleString()} 之间生成 {RANDOM_COUNT}{" "}
          个随机数，支持股票式滚动，自动求和
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 三个随机数 - 股票滚动卡片风格 */}
        <div className="grid grid-cols-3 gap-3">
          {RANDOM_SLOTS.map((slotId, i) => (
            <div
              key={slotId}
              className={
                "relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border bg-gradient-to-b p-4 shadow-lg transition-all duration-300 " +
                (rolling
                  ? "border-accent bg-accent/20 shadow-accent/30 animate-pulse"
                  : "border-accent/40 bg-background/80 shadow-sm")
              }
            >
              {/* 顶部光效条 */}
              <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-accent to-transparent opacity-70" />

              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                第 {i + 1} 个
              </span>

              <div
                className={
                  "font-mono text-2xl font-bold tabular-nums sm:text-3xl " +
                  (rolling ? "text-accent-foreground" : "text-accent-foreground")
                }
              >
                <AnimatedNumber value={values[i] ?? RNG_MIN} duration={rolling ? 60 : 700} />
              </div>

              {/* 底部装饰线 */}
              <div className="w-full border-t border-dashed border-accent/30" />

              <Button
                size="sm"
                variant="secondary"
                onClick={() => regenerate(i)}
                disabled={rolling}
                className="h-7 gap-1 text-xs"
              >
                <RefreshCw className={`h-3 w-3 ${rolling ? "animate-spin" : ""}`} />
                换一个
              </Button>
            </div>
          ))}
        </div>

        {/* 自动滚动控制条 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-accent/40 bg-accent/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-accent-foreground">
            <RefreshCw className={`h-4 w-4 ${rolling ? "animate-spin" : ""}`} />
            自动滚动
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRollSpeedIndex((i) => (i + 1) % RNG_SPEEDS.length)}
              className="h-8 gap-1 text-xs"
              disabled={rolling}
            >
              <Gauge className="h-3 w-3" />
              {RNG_SPEEDS[rollSpeedIndex].label}
            </Button>
            <Button
              size="sm"
              onClick={toggleRoll}
              className="h-8 gap-1"
              variant={rolling ? "destructive" : "default"}
            >
              {rolling ? (
                <>
                  <Pause className="h-3 w-3" />
                  停止
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  开始
                </>
              )}
            </Button>
            <div className="mx-1 h-6 w-px bg-muted-foreground/20" />
            <Button size="sm" onClick={regenerateAll} disabled={rolling} className="h-8 gap-1">
              <Shuffle className="h-3 w-3" />
              全部重新生成
            </Button>
          </div>
        </div>

        {/* 自动求和 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sigma className="h-4 w-4" />
            自动求和 (Sum)
          </div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary/70" />
            <div className="font-mono text-3xl font-bold tabular-nums text-primary sm:text-4xl">
              <AnimatedNumber value={sum} duration={rolling ? 80 : 800} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
// ──────────────────────────────────────────────
// 主应用
// ──────────────────────────────────────────────
export function App() {
  return (
    <div className="min-h-svh bg-gradient-to-br from-background via-muted/30 to-background p-4 sm:p-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {/* Page Header */}
        <header className="flex flex-col gap-2 px-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Zap className="size-7 text-yellow-500" aria-hidden="true" />
            奇妙组件工坊
          </h1>
          <p className="text-sm text-muted-foreground">
            交互式组件演示，数字变化时有平滑滚动动画。
          </p>
        </header>

        {/* 功能卡片网格 */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 ">
          <CounterCard />
          <RandomCard />
          <TimerCard />
          <StopwatchCard />
          {/* 科学计算器：桌面端横跨两列以容纳更多按钮 */}
          <div className="md:col-span-2">
            <ScientificCalculatorCard />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
