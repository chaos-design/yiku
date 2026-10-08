import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
  maxTextSize: 250000,
  themeVariables: {
    background: "#141618",
    primaryColor: "#1b1e21",
    primaryTextColor: "#f3f0e9",
    primaryBorderColor: "#34393d",
    lineColor: "#6f9dff",
    secondaryColor: "#24282c",
    tertiaryColor: "#1b1e21",
    textFillColor: "#f3f0e9",
    mainBkg: "#1b1e21",
    nodeBorder: "#34393d",
    clusterBkg: "#1b1e21",
    clusterBorder: "#34393d",
    titleColor: "#f3f0e9",
    edgeLabelBackground: "#141618",
  },
  flowchart: { htmlLabels: false, curve: "linear" },
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugifyHeading(text: string): string {
  // GitHub-style id: lowercase, spaces -> dashes, keep CJK.
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * `marked` may pass the code block as a string (older) or a token object
 * (newer). The source text can live under `code`, `text`, or `raw`.
 */
type CodeToken = {
  code?: string;
  text?: string;
  raw?: string;
  lang?: string;
};

function renderCodeBlock(codeOrToken: string | CodeToken, lang?: string): string {
  const code =
    typeof codeOrToken === "string"
      ? codeOrToken
      : (codeOrToken.code ?? codeOrToken.text ?? codeOrToken.raw ?? "");
  const language = (
    lang ?? (typeof codeOrToken === "string" ? undefined : codeOrToken.lang)
  )?.trim();

  if (language === "mermaid") {
    return `<pre class="mermaid" data-mermaid="${escapeHtml(code)}"></pre>`;
  }

  const cls = language ? ` class="hljs language-${language}"` : ` class="hljs"`;
  const body =
    language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : escapeHtml(code);
  return `<pre><code${cls}>${body}</code></pre>`;
}

const markedInstance: Marked = new Marked({ gfm: true, breaks: false });
markedInstance.use({
  renderer: {
    code(codeOrToken: string | CodeToken, lang?: string) {
      return renderCodeBlock(codeOrToken, lang);
    },
  },
});

export interface TocItem {
  id: string;
  text: string;
  depth: number;
}

export interface RenderResult {
  toc: TocItem[];
}

/**
 * Render markdown into `container`, then:
 *  - assign heading ids and build a table of contents,
 *  - rewrite relative .md links to app hash routes,
 *  - turn mermaid blocks into SVG.
 */
export async function renderIntoDoc(
  container: HTMLElement,
  markdown: string,
  fromSlug: string,
): Promise<RenderResult> {
  container.innerHTML = markedInstance.parse(markdown) as string;

  // Assign ids + TOC.
  const headings = Array.from(container.querySelectorAll(":scope > h1, :scope > h2, :scope > h3"));
  const toc: TocItem[] = [];
  for (const h of headings) {
    const id = slugifyHeading(h.textContent ?? "");
    if (!id) continue;
    h.id = id;
    const depth = Number(h.tagName.slice(1));
    if (depth === 2 || depth === 3) {
      toc.push({ id, text: h.textContent ?? "", depth });
    }
  }

  // Rewrite doc links.
  for (const a of Array.from(container.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    const next = resolveDocLink(href, fromSlug);
    if (next !== href) {
      a.setAttribute("href", next);
      if (next.startsWith("#")) a.removeAttribute("target");
      else a.setAttribute("target", "_blank");
    }
  }

  // Render mermaid diagrams.
  const blocks = Array.from(container.querySelectorAll("pre.mermaid[data-mermaid]"));
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const def = block.getAttribute("data-mermaid") ?? "";
    const holder = document.createElement("div");
    holder.className = "mermaid-diagram";
    holder.innerHTML = `<div class="mermaid-fallback">图表渲染中…</div>`;
    block.replaceWith(holder);
    try {
      const id = `yiku-mermaid-${Math.random().toString(36).slice(2, 10)}-${i}`;
      const out = await mermaid.render(id, def);
      const svg = typeof out === "string" ? out : ((out as { svg?: string }).svg ?? "");
      holder.innerHTML = svg;
    } catch (err) {
      console.error("mermaid render failed", err);
      holder.innerHTML = `<div class="mermaid-fallback">图表渲染失败</div>`;
    }
  }

  return { toc };
}

/**
 * Given a markdown link `href` and the current document slug, rewrite relative
 * .md links to app hash routes ("#/doc/atoms/sandbox").
 */
function resolveDocLink(href: string, fromSlug: string): string {
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("#") ||
    href.startsWith("mailto:")
  ) {
    return href;
  }
  if (!href.endsWith(".md")) {
    return href;
  }
  const base = fromSlug.split("/").slice(0, -1);
  const resolved: string[] = [];
  for (const part of [...base, ...href.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `#/doc/${resolved.join("/")}`;
}
