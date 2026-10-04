import { FileText, LoaderCircle } from "lucide-react";
import { marked, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode, useMemo } from "react";
import type { ResearchRunStatus } from "../types.js";

interface MarkdownReportProps {
  readonly content: string;
  readonly status: ResearchRunStatus;
}

export function MarkdownReport({ content, status }: MarkdownReportProps) {
  const streaming = status === "queued" || status === "running";

  return (
    <section aria-labelledby="report-heading" className="report-panel">
      <header className="section-heading report-heading">
        <div>
          <span className="eyebrow">RESEARCH OUTPUT</span>
          <h2 id="report-heading">研究报告</h2>
        </div>
        <span className={`report-state is-${streaming ? "streaming" : status}`}>
          {streaming ? <LoaderCircle aria-hidden="true" size={14} /> : <FileText size={14} />}
          {streaming ? "生成中" : reportStatusLabel(status)}
        </span>
      </header>

      <article aria-live="polite" className="markdown-report">
        {content ? (
          <MarkdownContent content={content} />
        ) : (
          <div className="report-empty">
            <span>R</span>
            <div>
              <strong>等待研究任务</strong>
              <p>最终报告将在搜索、证据核验和综合完成后出现在这里。</p>
            </div>
          </div>
        )}
        {streaming && content ? <span aria-hidden="true" className="stream-caret" /> : null}
      </article>
    </section>
  );
}

export function MarkdownContent({
  className = "",
  content,
}: {
  readonly className?: string | undefined;
  readonly content: string;
}) {
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  return <div className={className}>{rendered}</div>;
}

function renderMarkdown(value: string): ReactNode {
  if (!value) {
    return null;
  }

  try {
    return renderBlocks(marked.lexer(value, { breaks: true, gfm: true }));
  } catch {
    return <pre className="markdown-fallback">{value}</pre>;
  }
}

function renderBlocks(tokens: readonly Token[]): ReactNode {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}-${token.raw.slice(0, 12)}`;

    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const children = renderInline(heading.tokens);
        if (heading.depth === 1) {
          return <h1 key={key}>{children}</h1>;
        }
        if (heading.depth === 2) {
          return <h2 key={key}>{children}</h2>;
        }
        return <h3 key={key}>{children}</h3>;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        return <p key={key}>{renderInline(paragraph.tokens)}</p>;
      }
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens !== undefined ? (
          <p key={key}>{renderInline(text.tokens)}</p>
        ) : (
          <p key={key}>{text.text}</p>
        );
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        return <blockquote key={key}>{renderBlocks(quote.tokens)}</blockquote>;
      }
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item) => (
          <li key={`${key}-item-${item.raw}`}>{renderBlocks(item.tokens)}</li>
        ));
        return list.ordered ? (
          <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "code": {
        const code = token as Tokens.Code;
        return (
          <pre key={key}>
            <code className={code.lang ? `language-${code.lang}` : undefined}>{code.text}</code>
          </pre>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <div className="markdown-table-wrap" key={key}>
            <table>
              <thead>
                <tr>
                  {table.header.map((cell) => (
                    <th key={`${key}-head-${cell.text}`}>{renderInline(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => {
                  const rowKey = row.map((cell) => cell.text).join("|");
                  return (
                    <tr key={`${key}-row-${rowKey}`}>
                      {row.map((cell) => (
                        <td key={`${key}-cell-${rowKey}-${cell.text}`}>
                          {renderInline(cell.tokens)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      }
      case "hr":
        return <hr key={key} />;
      case "html":
        return <p key={key}>{(token as Tokens.HTML).text}</p>;
      case "space":
      case "def":
        return null;
      default: {
        const children = getTokenChildren(token);
        return (
          <Fragment key={key}>
            {children !== undefined ? renderInline(children) : token.raw}
          </Fragment>
        );
      }
    }
  });
}

function renderInline(tokens: readonly Token[]): ReactNode {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}-${token.raw.slice(0, 8)}`;

    switch (token.type) {
      case "text":
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Text | Tokens.Escape).text}</Fragment>;
      case "strong": {
        const strong = token as Tokens.Strong;
        return <strong key={key}>{renderInline(strong.tokens)}</strong>;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return <em key={key}>{renderInline(emphasis.tokens)}</em>;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        return <del key={key}>{renderInline(deleted.tokens)}</del>;
      }
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeExternalUrl(link.href);
        return href === undefined ? (
          <Fragment key={key}>{renderInline(link.tokens)}</Fragment>
        ) : (
          <a href={href} key={key} rel="noreferrer" target="_blank" title={link.title ?? undefined}>
            {renderInline(link.tokens)}
          </a>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeExternalUrl(image.href);
        return href === undefined ? (
          <Fragment key={key}>{image.text}</Fragment>
        ) : (
          <a href={href} key={key} rel="noreferrer" target="_blank">
            {image.text || "查看图片来源"}
          </a>
        );
      }
      case "br":
        return <br key={key} />;
      case "html":
        return <Fragment key={key}>{(token as Tokens.HTML).text}</Fragment>;
      default: {
        const children = getTokenChildren(token);
        return (
          <Fragment key={key}>
            {children !== undefined ? renderInline(children) : token.raw}
          </Fragment>
        );
      }
    }
  });
}

function getTokenChildren(token: Token): readonly Token[] | undefined {
  if (!("tokens" in token) || !Array.isArray(token.tokens)) {
    return undefined;
  }

  return token.tokens as readonly Token[];
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function reportStatusLabel(status: ResearchRunStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "待开始";
  }
}
