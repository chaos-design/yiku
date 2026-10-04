import type { ResearchEvidence } from "@yiku/agent-research";
import {
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import type { ResearchTurnSnapshot } from "../types.js";
import { MarkdownContent } from "./markdown-report.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

interface AssistantResponseProps {
  readonly content: string;
  readonly turn?: ResearchTurnSnapshot | undefined;
}

export function AssistantResponse({ content, turn }: AssistantResponseProps) {
  const [copied, setCopied] = useState(false);
  const streaming = turn?.status === "queued" || turn?.status === "running";
  const failed = turn?.status === "failed";
  const evidence = turn?.evidence ?? [];

  const handleCopy = async () => {
    setCopied(await copyText(content));
  };

  return (
    <section
      aria-label="研究结论"
      aria-live={streaming ? "polite" : "off"}
      className={`assistant-response${streaming ? " is-streaming" : ""}${
        failed ? " is-failed" : ""
      }`}
    >
      <header className="assistant-response-header">
        <div>
          <span>
            <FileText />
            研究结论
          </span>
          <small>
            {content.length.toLocaleString("zh-CN")} 字符
            {evidence.length > 0 ? ` · ${evidence.length} 个来源` : ""}
          </small>
        </div>
        <div className="assistant-response-actions">
          <Badge variant={responseVariant(turn)}>
            {streaming ? (
              <LoaderCircle data-icon="inline-start" />
            ) : failed ? (
              <CircleAlert data-icon="inline-start" />
            ) : (
              <ShieldCheck data-icon="inline-start" />
            )}
            {responseStatus(turn)}
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copied ? "研究结论已复制" : "复制研究结论"}
                disabled={!content}
                onClick={() => void handleCopy()}
                size="icon-xs"
                variant="ghost"
              >
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "已复制" : "复制研究结论"}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {content ? (
        <div className="assistant-response-content">
          <MarkdownContent className="message-markdown" content={content} />
          {streaming ? <span aria-hidden="true" className="response-stream-caret" /> : null}
        </div>
      ) : (
        <div className="assistant-response-empty">
          <span aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p>{streaming ? "正在综合证据并生成研究结论" : "本次运行没有生成研究结论"}</p>
        </div>
      )}

      {evidence.length > 0 ? <EvidenceSources evidence={evidence} /> : null}
    </section>
  );
}

function EvidenceSources({ evidence }: { readonly evidence: readonly ResearchEvidence[] }) {
  const [open, setOpen] = useState(false);
  const primaryCount = evidence.filter((item) => item.sourceType === "primary").length;
  const corroboratedCount = evidence.filter((item) => item.verification === "corroborated").length;

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="response-sources">
        <CollapsibleTrigger asChild>
          <Button
            aria-label={open ? "收起研究来源" : "展开研究来源"}
            data-role="sources-trigger"
            variant="ghost"
          >
            <span>
              <BookOpenCheck />
              <strong>{evidence.length} 个已记录来源</strong>
              <small>
                主要来源 {primaryCount}
                {corroboratedCount > 0 ? ` · 交叉核验 ${corroboratedCount}` : ""}
              </small>
            </span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <ol className="response-source-list">
            {evidence.map((item, index) => (
              <li key={item.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <a href={item.url} rel="noreferrer" target="_blank">
                    <strong>{item.title}</strong>
                    <ExternalLink />
                  </a>
                  <p>{sourceSummary(item)}</p>
                  <footer>
                    <Badge variant={item.sourceType === "primary" ? "secondary" : "outline"}>
                      {sourceTypeLabel(item.sourceType)}
                    </Badge>
                    <Badge variant={item.verification === "unverified" ? "destructive" : "outline"}>
                      {verificationLabel(item.verification)}
                    </Badge>
                    <small>{formatSourceHost(item.url)}</small>
                  </footer>
                </div>
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function sourceSummary(evidence: ResearchEvidence): string {
  const claims = evidence.claims.filter((claim) => claim.trim()).slice(0, 2);
  if (claims.length === 0) {
    return "该来源已写入 Evidence Ledger，暂无公开主张摘要。";
  }
  const summary = claims.join("；");
  return evidence.claims.length > claims.length
    ? `${summary}；另有 ${evidence.claims.length - 2} 条`
    : summary;
}

function formatSourceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./u, "");
  } catch {
    return "external source";
  }
}

function sourceTypeLabel(sourceType: ResearchEvidence["sourceType"]): string {
  switch (sourceType) {
    case "primary":
      return "主要来源";
    case "independent":
      return "独立来源";
    case "secondary":
      return "次要来源";
  }
}

function verificationLabel(verification: ResearchEvidence["verification"]): string {
  switch (verification) {
    case "corroborated":
      return "已交叉核验";
    case "single-source":
      return "单一来源";
    case "unverified":
      return "未核验";
  }
}

function responseStatus(turn: ResearchTurnSnapshot | undefined): string {
  switch (turn?.status) {
    case "queued":
      return "等待生成";
    case "running":
      return "实时生成";
    case "failed":
      return "包含诊断";
    case "cancelled":
      return "已停止";
    case "completed":
      return turn.validation?.passed === false ? "校验失败" : "引用已校验";
    default:
      return "研究回答";
  }
}

function responseVariant(
  turn: ResearchTurnSnapshot | undefined,
): "destructive" | "outline" | "secondary" {
  if (turn?.status === "failed" || turn?.validation?.passed === false) {
    return "destructive";
  }
  return turn?.status === "completed" ? "secondary" : "outline";
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}
