// Docs are inlined at build time through the virtual module produced by
// vite.config.ts. The key is the docs-relative path without the .md extension,
// e.g. "architecture/system-overview". Chinese docs live in docs/, English
// translations in docs/en/ under identical keys; any missing English doc falls
// back to the Chinese source.

import { docsByLang } from "virtual:yiku-docs";

export type Lang = "zh" | "en";
export const LANGS: Lang[] = ["zh", "en"];

export interface DocSection {
  id: string;
  title: string;
  blurb: string;
  items: DocItem[];
}

export interface DocItem {
  slug: string;
  title: string;
  summary: string;
}

export interface DocCatalog {
  sections: DocSection[];
  index: Record<string, DocItem>;
}

function summaryOf(raw: string): string {
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t.replace(/^[-*+]\s+/, "").slice(0, 140);
  }
  return "";
}

function heading(raw: string): string {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

// Curated sections in reading order. Each `slugs` list names docs that belong
// to the section; any doc not referenced anywhere is auto-filed under a
// trailing "其他/Other" section so no document is ever dropped from the catalog.
const sectionDefs: {
  id: string;
  title: Record<Lang, string>;
  blurb: Record<Lang, string>;
  slugs: string[];
}[] = [
  {
    id: "top",
    title: { zh: "总览", en: "Overview" },
    blurb: {
      zh: "文档中心与维护索引。",
      en: "Doc center and maintenance index.",
    },
    slugs: ["README"],
  },
  {
    id: "architecture",
    title: { zh: "架构层", en: "Architecture" },
    blurb: {
      zh: "跨包组合、依赖方向、运行生命周期与工程不变量。",
      en: "Cross-package composition, dependency direction, runtime lifecycle and engineering invariants.",
    },
    slugs: [
      "architecture/system-overview",
      "architecture/package-boundaries",
      "architecture/runtime-and-orchestration",
      "architecture/observability",
      "architecture/engineering",
    ],
  },
  {
    id: "features",
    title: { zh: "功能层", en: "Features" },
    blurb: {
      zh: "用户或宿主可直接使用的能力、配置与失败语义。",
      en: "Capabilities, configuration and failure semantics directly usable by users or hosts.",
    },
    slugs: [
      "features/cli",
      "features/code-agent",
      "features/research-agent",
      "features/subagents",
      "features/context-compaction",
      "features/permissions",
      "features/skills",
      "features/hooks",
      "features/memories",
      "features/evaluations",
      "features/agent-studio",
    ],
  },
  {
    id: "atoms",
    title: { zh: "原子层", en: "Atoms" },
    blurb: {
      zh: "基础协议、稳定类型、存储与底层算法边界。",
      en: "Base protocols, stable types, storage and low-level algorithm boundaries.",
    },
    slugs: [
      "atoms/atomic-flow",
      "atoms/atom-catalog",
      "atoms/configuration-and-storage",
      "atoms/sandbox",
      "atoms/trajectory",
      "atoms/flow-graph",
    ],
  },
  {
    id: "deployment",
    title: { zh: "部署", en: "Deployment" },
    blurb: {
      zh: "站点的本地开发、构建与两条部署路径。",
      en: "Local development, build, and the two deployment paths for the site.",
    },
    slugs: ["deployment"],
  },
];

// Raw markdown per language; missing English docs fall back to Chinese.
const rawByLang: Record<Lang, Record<string, string>> = {
  zh: docsByLang.zh,
  en: { ...docsByLang.zh, ...docsByLang.en },
};

const catalogs: Record<Lang, DocCatalog> = {} as Record<Lang, DocCatalog>;

function buildCatalog(lang: Lang): DocCatalog {
  const index: Record<string, DocItem> = {};
  for (const key of Object.keys(rawByLang[lang]).sort()) {
    const raw = rawByLang[lang][key];
    index[key] = { slug: key, title: heading(raw) || key, summary: summaryOf(raw) };
  }

  const referenced = new Set(sectionDefs.flatMap((s) => s.slugs));
  const sections: DocSection[] = sectionDefs.map((def) => ({
    id: def.id,
    title: def.title[lang],
    blurb: def.blurb[lang],
    items: def.slugs.filter((s) => index[s]).map((s) => index[s]),
  }));

  // Auto-file any docs that were not explicitly listed, so the catalog is total.
  const leftovers = Object.keys(index).filter((k) => !referenced.has(k));
  if (leftovers.length > 0) {
    sections.push({
      id: "misc",
      title: lang === "zh" ? "其他" : "Other",
      blurb: lang === "zh" ? "未归入上述分组的文档。" : "Docs not covered by the groups above.",
      items: leftovers.map((k) => index[k]),
    });
  }

  return { sections, index };
}

/** Curated catalog for a language (built lazily, then cached). */
export function catalogFor(lang: Lang): DocCatalog {
  if (!catalogs[lang]) catalogs[lang] = buildCatalog(lang);
  return catalogs[lang];
}

// Default catalog kept for convenience (Chinese source of truth).
export const docCatalog: DocCatalog = catalogFor("zh");

/** Resolve a hash route "#/doc/<slug>" to its raw markdown in the given language. */
export function getDoc(slug: string, lang: Lang = "zh"): { raw: string; item: DocItem } | null {
  const catalog = catalogFor(lang);
  const item = catalog.index[slug];
  if (!item) return null;
  return { raw: rawByLang[lang][slug] ?? "", item };
}

/** Flatten slugs in reading order (section order, not alphabetical). */
export function orderedDocSlugs(): string[] {
  return docCatalog.sections.flatMap((s) => s.items.map((i) => i.slug));
}
