import { useEffect, useRef, useState } from "react";
import { docCatalog, getDoc, orderedDocSlugs } from "./docs";
import { renderIntoDoc, type TocItem } from "./markdown";
import { ROUTES } from "./routes";

export function DocView({ slug }: { slug: string }) {
  const result = getDoc(slug);
  const ref = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    setToc([]);
    if (!result || !ref.current) {
      setRendering(false);
      return;
    }
    renderIntoDoc(ref.current, result.raw, slug).then((res) => {
      if (cancelled) return;
      setToc(res.toc);
      setRendering(false);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, result]);

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
          <div ref={ref} className="doc-body" aria-busy={rendering}>
            {rendering ? <p style={{ color: "var(--faint)" }}>渲染中…</p> : null}
          </div>

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

        {toc.length > 0 ? (
          <div className="doc-toc">
            <h4>本页目录</h4>
            <ol>
              {toc.map((t) => (
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
