import { Calculator, Delete, History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type AngleMode, CalcError, evaluate, formatResult } from "@/lib/calculator";
import { cn } from "@/lib/utils";

interface HistoryEntry {
  id: number;
  expression: string;
  result: string;
}

type ButtonKind = "num" | "op" | "fn" | "action" | "equals";

interface CalcButton {
  label: string;
  insert?: string;
  kind: ButtonKind;
  /** 横向跨度（grid 列数），默认为 1 */
  span?: 1 | 2;
  title?: string;
}

const SCIENTIFIC_BUTTONS: CalcButton[] = [
  // 第一行：三角函数 + 常量 + 幂
  { label: "sin", insert: "sin(", kind: "fn" },
  { label: "cos", insert: "cos(", kind: "fn" },
  { label: "tan", insert: "tan(", kind: "fn" },
  { label: "π", insert: "π", kind: "fn" },
  { label: "e", insert: "e", kind: "fn" },
  { label: "x^y", insert: "^", kind: "op", title: "幂运算" },

  // 第二行：反三角函数 + 对数 + 阶乘
  { label: "asin", insert: "asin(", kind: "fn" },
  { label: "acos", insert: "acos(", kind: "fn" },
  { label: "atan", insert: "atan(", kind: "fn" },
  { label: "ln", insert: "ln(", kind: "fn" },
  { label: "log", insert: "log(", kind: "fn" },
  { label: "n!", insert: "!", kind: "op" },

  // 第三行：根号/幂/括号
  { label: "√", insert: "sqrt(", kind: "fn", title: "平方根 sqrt" },
  { label: "∛", insert: "cbrt(", kind: "fn", title: "立方根 cbrt" },
  { label: "exp", insert: "exp(", kind: "fn" },
  { label: "|x|", insert: "abs(", kind: "fn" },
  { label: "(", insert: "(", kind: "op" },
  { label: ")", insert: ")", kind: "op" },
];

const KEYPAD_BUTTONS: CalcButton[] = [
  // 第一行
  { label: "C", kind: "action", title: "清除全部 (Esc)" },
  { label: "( )", insert: "(", kind: "action", title: "左括号" },
  { label: "%", insert: "%", kind: "op" },
  { label: "÷", insert: "/", kind: "op" },

  // 第二行
  { label: "7", insert: "7", kind: "num" },
  { label: "8", insert: "8", kind: "num" },
  { label: "9", insert: "9", kind: "num" },
  { label: "×", insert: "*", kind: "op" },

  // 第三行
  { label: "4", insert: "4", kind: "num" },
  { label: "5", insert: "5", kind: "num" },
  { label: "6", insert: "6", kind: "num" },
  { label: "−", insert: "-", kind: "op" },

  // 第四行
  { label: "1", insert: "1", kind: "num" },
  { label: "2", insert: "2", kind: "num" },
  { label: "3", insert: "3", kind: "num" },
  { label: "+", insert: "+", kind: "op" },

  // 第五行
  { label: "0", insert: "0", kind: "num", span: 2 },
  { label: ".", insert: ".", kind: "num" },
  { label: "=", kind: "equals", title: "计算 (Enter)" },
];

function buttonClasses(kind: ButtonKind) {
  switch (kind) {
    case "num":
      return "bg-secondary text-secondary-foreground hover:enabled:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] font-semibold";
    case "op":
      return "bg-blue-500/10 text-blue-600 hover:enabled:bg-blue-500/20 dark:text-blue-300 font-semibold";
    case "fn":
      return "bg-purple-500/10 text-purple-600 hover:enabled:bg-purple-500/20 dark:text-purple-300 text-xs sm:text-sm";
    case "action":
      return "bg-muted text-foreground hover:enabled:bg-muted/70 font-medium";
    case "equals":
      return "bg-sky-500 text-white hover:enabled:bg-sky-500/90 font-bold shadow-md shadow-sky-500/30";
  }
}

export function ScientificCalculatorCard() {
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [angleMode, setAngleMode] = useState<AngleMode>("DEG");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const historyIdRef = useRef(0);
  const displayRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 实时计算预览：在用户输入时给出结果预览
   */
  const preview = useMemo(() => {
    if (!expression) return "";
    try {
      const value = evaluate(expression, { angleMode });
      return formatResult(value);
    } catch {
      return "";
    }
  }, [expression, angleMode]);

  const insertText = useCallback((text: string) => {
    setError(null);
    setExpression((prev) => prev + text);
  }, []);

  const backspace = useCallback(() => {
    setError(null);
    setExpression((prev) => prev.slice(0, -1));
  }, []);

  const clearAll = useCallback(() => {
    setExpression("");
    setResult("");
    setError(null);
  }, []);

  const commitResult = useCallback(
    (finalExpr: string) => {
      if (!finalExpr.trim()) return;
      try {
        const value = evaluate(finalExpr, { angleMode });
        const formatted = formatResult(value);
        setResult(formatted);
        setError(null);
        setHistory((prev) => {
          const entry: HistoryEntry = {
            id: ++historyIdRef.current,
            expression: finalExpr,
            result: formatted,
          };
          return [entry, ...prev].slice(0, 20);
        });
        // 把结果作为下一次输入的起始（去掉千位分隔符）
        setExpression(formatted.replace(/,/g, ""));
      } catch (e) {
        if (e instanceof CalcError) {
          setError(e.message);
        } else {
          setError("计算出错");
        }
        setResult("");
      }
    },
    [angleMode],
  );

  const handleButtonClick = useCallback(
    (btn: CalcButton) => {
      // "C" 是特殊按钮：清除
      if (btn.label === "C") {
        clearAll();
        return;
      }
      // "=" 触发计算
      if (btn.kind === "equals") {
        commitResult(expression);
        return;
      }
      if (btn.insert !== undefined) {
        insertText(btn.insert);
      }
    },
    [clearAll, commitResult, expression, insertText],
  );

  /**
   * 物理键盘支持
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (e.key === "Enter" || e.key === "=") {
        e.preventDefault();
        commitResult(expression);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearAll();
        return;
      }
      const k = e.key;
      if (/^[0-9]$/.test(k)) {
        e.preventDefault();
        insertText(k);
        return;
      }
      if (k === ".") {
        e.preventDefault();
        insertText(".");
        return;
      }
      if ("+-*/^%()!".includes(k)) {
        e.preventDefault();
        insertText(k);
        return;
      }
      // Alt+P 输入 π
      if (e.altKey && (k === "p" || k === "P")) {
        e.preventDefault();
        insertText("π");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [backspace, clearAll, commitResult, expression, insertText]);

  // 长表达式自动滚到末尾（表达式变化时触发）
  useEffect(() => {
    const el = displayRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  });

  return (
    <Card className="border-sky-400/40 bg-sky-400/5 shadow-lg shadow-sky-400/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5 text-sky-500" />
          科学计算器
        </CardTitle>
        <CardDescription>支持函数、括号、幂运算、阶乘与 DEG/RAD 切换，支持物理键盘</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 顶部工具条：DEG/RAD + 历史 + 退格 + 清除 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-sky-400/30 bg-sky-400/5 p-1">
            {(["DEG", "RAD"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setAngleMode(m)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-semibold transition-colors",
                  angleMode === m
                    ? "bg-sky-500 text-white shadow"
                    : "text-sky-600 hover:bg-sky-500/10 dark:text-sky-300",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((v) => !v)}
              className="h-8 gap-1 text-xs"
              aria-pressed={showHistory}
            >
              <History className="h-3.5 w-3.5" />
              历史
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={backspace}
              className="h-8 gap-1 text-xs"
              title="退格 (Backspace)"
            >
              <Delete className="h-3.5 w-3.5" />
              退格
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearAll}
              className="h-8 gap-1 text-xs text-destructive"
              title="清除全部 (Esc)"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              清除
            </Button>
          </div>
        </div>

        {/* 显示屏 */}
        <div className="rounded-xl border-2 border-sky-400/40 bg-background/80 p-4 shadow-sm">
          <textarea
            ref={displayRef}
            value={expression}
            readOnly
            rows={1}
            aria-label="表达式"
            placeholder="输入表达式…"
            className="block w-full resize-none overflow-x-auto whitespace-nowrap border-0 bg-transparent p-0 text-right font-mono text-2xl font-semibold tabular-nums text-foreground outline-none focus:ring-0 sm:text-3xl"
          />
          <div className="mt-1 min-h-6 text-right font-mono text-sm tabular-nums text-muted-foreground sm:text-base">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : result ? (
              <span>= {result}</span>
            ) : preview ? (
              <span className="text-sky-500">≈ {preview}</span>
            ) : null}
          </div>
        </div>

        {/* 历史记录抽屉 */}
        {showHistory && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-sky-400/30 bg-background/60 p-2 text-sm">
            {history.length === 0 ? (
              <div className="py-3 text-center text-xs text-muted-foreground">暂无历史记录</div>
            ) : (
              history.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setExpression(h.expression);
                    setResult(h.result);
                    setError(null);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-sky-500/10"
                >
                  <span className="truncate text-muted-foreground">{h.expression}</span>
                  <span className="shrink-0 font-semibold text-sky-600 dark:text-sky-300">
                    = {h.result}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* 科学函数按钮：6 列 */}
        <div className="grid grid-cols-6 gap-2">
          {SCIENTIFIC_BUTTONS.map((btn) => (
            <CalcButtonView key={btn.label} btn={btn} onClick={handleButtonClick} />
          ))}
        </div>

        {/* 分隔线 */}
        <div className="h-px bg-border" />

        {/* 数字键盘：4 列，共 5 行 */}
        <div className="grid grid-cols-4 gap-2">
          {KEYPAD_BUTTONS.map((btn) => (
            <CalcButtonView key={btn.label} btn={btn} onClick={handleButtonClick} />
          ))}
        </div>

        <p className="text-center text-[0.7rem] text-muted-foreground">
          键盘提示：数字 / + − × ÷ / ( ) / ^ / % / ! / Enter = 计算 · Backspace = 退格 · Esc = 清除
          · Alt+P = π
        </p>
      </CardContent>
    </Card>
  );
}

function CalcButtonView({ btn, onClick }: { btn: CalcButton; onClick: (btn: CalcButton) => void }) {
  return (
    <Button
      size="sm"
      onClick={() => onClick(btn)}
      title={btn.title ?? btn.label}
      className={cn(
        "h-11 rounded-lg text-sm shadow-sm transition-all active:translate-y-px",
        btn.span === 2 && "col-span-2",
        buttonClasses(btn.kind),
      )}
    >
      {btn.label}
    </Button>
  );
}

export default ScientificCalculatorCard;
