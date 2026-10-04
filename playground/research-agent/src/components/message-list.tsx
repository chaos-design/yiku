import { Bot, CheckCircle2, LoaderCircle, Search, UserRound } from "lucide-react";
import type { ResearchMessage, ResearchTurnSnapshot } from "../types.js";
import { AssistantResponse } from "./assistant-response.js";
import { MarkdownContent } from "./markdown-report.js";
import { ResearchTrace } from "./research-trace.js";

const EXAMPLES = [
  "研究 2026 年 Agent 可观测性的主要趋势，并给出可靠来源。",
  "比较主流 AI Agent SDK 的编排模型与适用场景。",
  "分析 Web Search Agent 如何降低错误引用风险。",
] as const;

interface MessageListProps {
  readonly messages: readonly ResearchMessage[];
  readonly onExample: (prompt: string) => void;
  readonly turn?: ResearchTurnSnapshot | undefined;
  readonly turns: readonly ResearchTurnSnapshot[];
}

export function MessageList({ messages, onExample, turn, turns }: MessageListProps) {
  if (messages.length === 0 && turn === undefined) {
    return (
      <section className="research-welcome">
        <div className="welcome-signal">
          <span />
          <Search size={23} />
        </div>
        <span className="welcome-eyebrow">EVIDENCE-FIRST RESEARCH AGENT</span>
        <h1>
          从一个问题开始，
          <br />
          <em>追踪结论如何形成。</em>
        </h1>
        <p>Research Agent 会规划查询、检索实时网页、记录证据、寻找反证并校验最终引用。</p>
        <div className="welcome-examples">
          {EXAMPLES.map((example, index) => (
            <button key={example} onClick={() => onExample(example)} type="button">
              <span>{String(index + 1).padStart(2, "0")}</span>
              {example}
            </button>
          ))}
        </div>
      </section>
    );
  }

  const hasAssistantMessageForTurn =
    turn !== undefined &&
    messages.some((message) => message.turnId === turn.turnId && message.role === "assistant");
  const liveContent = turn?.output ?? turn?.streamedText ?? "";
  const showLiveMessage = turn !== undefined && !hasAssistantMessageForTurn;

  return (
    <section aria-live="polite" className="message-list">
      {messages.map((message) => {
        const messageTurn = findMessageTurn(message, turns, turn);
        return (
          <article className={`chat-message is-${message.role}`} key={message.messageId}>
            <div className="message-avatar">
              {message.role === "user" ? <UserRound size={15} /> : <Bot size={15} />}
            </div>
            <div className="message-body">
              <header>
                <strong>{message.role === "user" ? "你" : "Research Agent"}</strong>
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </header>
              {message.role === "assistant" ? (
                <>
                  {messageTurn === undefined ? null : <ResearchTrace turn={messageTurn} />}
                  {messageTurn === undefined ? (
                    <MarkdownContent className="message-markdown" content={message.content} />
                  ) : (
                    <AssistantResponse content={message.content} turn={messageTurn} />
                  )}
                </>
              ) : (
                <p>{message.content}</p>
              )}
            </div>
          </article>
        );
      })}

      {showLiveMessage ? (
        <article className={`chat-message is-assistant is-${turn.status}`}>
          <div className="message-avatar">
            <Bot size={15} />
          </div>
          <div className="message-body">
            <header>
              <strong>Research Agent</strong>
              <span className="live-message-status">
                {turn.status === "queued" || turn.status === "running" ? (
                  <LoaderCircle size={12} />
                ) : (
                  <CheckCircle2 size={12} />
                )}
                {statusLabel(turn.status)}
              </span>
            </header>
            <ResearchTrace turn={turn} />
            <AssistantResponse content={liveContent} turn={turn} />
            {turn.error ? <p className="message-error">{turn.error}</p> : null}
          </div>
        </article>
      ) : null}
    </section>
  );
}

function findMessageTurn(
  message: ResearchMessage,
  turns: readonly ResearchTurnSnapshot[],
  selectedTurn: ResearchTurnSnapshot | undefined,
): ResearchTurnSnapshot | undefined {
  if (message.turnId === undefined) {
    return undefined;
  }
  if (selectedTurn?.turnId === message.turnId) {
    return selectedTurn;
  }
  return turns.find((turn) => turn.turnId === message.turnId);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: ResearchTurnSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "等待执行";
    case "running":
      return "研究中";
    case "completed":
      return "已完成";
    case "failed":
      return "校验失败";
    case "cancelled":
      return "已停止";
  }
}
