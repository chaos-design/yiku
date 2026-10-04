import { SendHorizontal, Sparkles, SquareStop } from "lucide-react";
import type { FormEvent } from "react";

interface ResearchFormProps {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onCancel: () => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSubmit: () => void;
  readonly prompt: string;
}

const EXAMPLES = [
  "研究 2026 年 Agent 可观测性的主要趋势",
  "比较主流 AI Agent SDK 的编排模型",
  "分析 Web Search Agent 的引用可靠性实践",
] as const;

export function ResearchForm({
  busy,
  error,
  onCancel,
  onPromptChange,
  onSubmit,
  prompt,
}: ResearchFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section aria-labelledby="brief-heading" className="brief-panel">
      <header className="section-heading brief-heading">
        <div>
          <span className="eyebrow">RESEARCH BRIEF</span>
          <h2 id="brief-heading">定义研究问题</h2>
        </div>
        <Sparkles aria-hidden="true" size={16} />
      </header>

      <form onSubmit={handleSubmit}>
        <label htmlFor="research-prompt">你希望 Research Agent 查清什么？</label>
        <textarea
          disabled={busy}
          id="research-prompt"
          maxLength={8000}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="输入一个需要实时检索和交叉核验的问题..."
          rows={7}
          value={prompt}
        />
        <div className="prompt-meta">
          <span>LIVE WEB RESEARCH</span>
          <span>{prompt.length.toLocaleString("zh-CN")} / 8,000</span>
        </div>
        {error !== undefined ? <p className="form-error">{error}</p> : null}
        <div className="form-actions">
          {busy ? (
            <button className="button button-secondary" onClick={onCancel} type="button">
              <SquareStop size={16} />
              终止研究
            </button>
          ) : (
            <button className="button button-primary" disabled={!prompt.trim()} type="submit">
              开始研究
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </form>

      <div className="example-prompts">
        <span>示例问题</span>
        {EXAMPLES.map((example) => (
          <button
            disabled={busy}
            key={example}
            onClick={() => onPromptChange(example)}
            type="button"
          >
            {example}
          </button>
        ))}
      </div>
    </section>
  );
}
