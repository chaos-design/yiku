import { useEffect, useState } from "react";
import { docCatalog, getDoc, orderedDocSlugs } from "./docs";
import { type RenderedDoc, renderMarkdown } from "./markdown";
import { ROUTES } from "./routes";

export function DocView({ slug }: { slug: string }) {
  const result = getDoc(slug);
  const [doc, setDoc] = useState<RenderedDoc | null>(null);

  // Depend on `slug` only: `getDoc` returns a fresh object each render, and
  // re-running this effect on every render is what looped the earlier version
  // into a "stuck" state. Fetch the doc inside the effect instead.
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    const { raw } = getDoc(slug) ?? { raw: "" };
    renderMarkdown(raw, slug).then((rendered) => {
      if (cancelled) return;
      setDoc(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // In-page anchors (#heading) must scroll, not rewrite the site hash route
  // (#/doc/...). Clicking them as-is would replace the whole hash and send the
  // router to a not-found page. Intercept them here.
  useEffect(() => {
    if (!doc) return;
    const onAnchorClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#']");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.length <= 1 || href.startsWith("#/")) return; // site route or bare
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    document.addEventListener("click", onAnchorClick, true);
    return () => document.removeEventListener("click", onAnchorClick, true);
  }, [doc]);

  if (!result) {
    return (
      <div className="content-inner">
        <div className="crumb">文档</div>
        <h1 className="page-title">未找到文档</h1>
        <p className="page-desc">
          没有 slug 为 <code>{slug}</code> 的文档。
          <a href={ROUTES.home}>返回首页</a>。
        </p>
      </div>
    );
  }

  const slugs = orderedDocSlugs();
  const i = slugs.indexOf(slug);
  const prev = i > 0 ? slugs[i - 1] : null;
  const next = i >= 0 && i < slugs.length - 1 ? slugs[i + 1] : null;
  const sectionId = slug.split("/")[0];

  return (
    <div className="content-inner">
      <div className="crumb">
        <a href={ROUTES.home}>Yiku</a> /{" "}
        {docCatalog.sections.find((s) => s.id === sectionId)?.title ?? sectionId} /{" "}
        {result.item.title}
      </div>

      <div className="doc-layout">
        <div>
          <div
            className="doc-body"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: content is generated only by our own marked + hljs + mermaid pipeline over repository-provided docs; no external input can reach this value
            dangerouslySetInnerHTML={doc ? { __html: doc.html } : undefined}
          />
          {!doc ? (
            <p className="doc-loading" style={{ color: "var(--faint)" }}>
              渲染中…
            </p>
          ) : null}

          <div className="pager">
            {prev ? (
              <a href={ROUTES.doc(prev)}>
                <span className="pager-kicker">← 上一篇</span>
                <span className="pager-title">{docCatalog.index[prev]?.title ?? prev}</span>
              </a>
            ) : (
              <a className="empty" href={ROUTES.home}>
                <span className="pager-kicker">← 上一篇</span>
                <span className="pager-title">首页</span>
              </a>
            )}
            {next ? (
              <a href={ROUTES.doc(next)}>
                <span className="pager-kicker">下一篇 →</span>
                <span className="pager-title">{docCatalog.index[next]?.title ?? next}</span>
              </a>
            ) : (
              <a className="empty" href={ROUTES.gallery}>
                <span className="pager-kicker">下一篇 →</span>
                <span className="pager-title">产物画廊</span>
              </a>
            )}
          </div>
        </div>

        {doc && doc.toc.length > 0 ? (
          <div className="doc-toc">
            <h4>本页目录</h4>
            <ol>
              {doc.toc.map((t) => (
                <li key={t.id} style={{ paddingLeft: t.depth === 3 ? 14 : 0 }}>
                  <a href={`#${t.id}`}>{t.text}</a>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  );
}
