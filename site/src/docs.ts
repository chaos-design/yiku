// Docs are inlined at build time through the virtual module produced by
// vite.config.ts. The key is the docs-relative path without the .md extension,
// e.g. "architecture/system-overview".
import { docs } from "virtual:yiku-docs";

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
  const lines = raw.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.replace(/^[-*+]\s+/, "").slice(0, 140);
  }
  return "";
}

function heading(raw: string): string {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

const sections: DocSection[] = [
  {
    id: "architecture",
    title: "架构层",
    blurb: "跨包组合、依赖方向、运行生命周期与工程不变量。",
    items: [],
  },
  {
    id: "features",
    title: "功能层",
    blurb: "用户或宿主可直接使用的能力、配置与失败语义。",
    items: [],
  },
  {
    id: "atoms",
    title: "原子层",
    blurb: "基础协议、稳定类型、存储与底层算法边界。",
    items: [],
  },
];

const catalog: DocCatalog = {
  sections,
  index: {},
};

for (const key of Object.keys(docs).sort()) {
  const raw = docs[key];
  const top = key.split("/")[0];
  const title = heading(raw) || key;
  const item: DocItem = { slug: key, title, summary: summaryOf(raw) };
  catalog.index[key] = item;

  // docs/README.md is the doc-center home; surface it under the top level.
  const section =
    top === "README"
      ? { id: "top", title: "总览", blurb: "文档中心与维护索引。", items: [] }
      : sections.find((s) => s.id === top);
  if (section) {
    section.items.push(item);
  } else {
    const created: DocSection = {
      id: top,
      title: top,
      blurb: "",
      items: [],
    };
    created.items.push(item);
    sections.unshift(created);
  }
}

// Ensure a stable top-level "总览" section holds docs/README.md.
const top = catalog.sections.find((s) => s.id === "top");
if (top) {
  catalog.sections = [top, ...catalog.sections.filter((s) => s.id !== "top")];
}

export const docCatalog = catalog;

/** Resolve a hash route "#/doc/<slug>" to its raw markdown. */
export function getDoc(slug: string): { raw: string; item: DocItem } | null {
  const item = catalog.index[slug];
  if (!item) return null;
  return { raw: docs[slug] ?? "", item };
}

/** Flatten slugs in reading order (section order, not alphabetical). */
export function orderedDocSlugs(): string[] {
  return catalog.sections.flatMap((s) => s.items.map((i) => i.slug));
}
