// Docs are inlined at build time through the virtual module produced by
// vite.config.ts. The key is the docs-relative path without the .md extension,
// e.g. "architecture/system-overview".

import { docs } from "virtual:yiku-docs";
import type { LocalizedText } from "./i18n";

export interface DocSection {
  id: string;
  title: LocalizedText;
  blurb: LocalizedText;
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
    title: { zh: "架构层", en: "Architecture" },
    blurb: {
      zh: "跨包组合、依赖方向、运行生命周期与工程不变量。",
      en: "Cross-package composition, dependency direction, runtime lifecycle and engineering invariants.",
    },
    items: [],
  },
  {
    id: "features",
    title: { zh: "功能层", en: "Features" },
    blurb: {
      zh: "用户或宿主可直接使用的能力、配置与失败语义。",
      en: "Capabilities, configuration and failure semantics directly usable by users or hosts.",
    },
    items: [],
  },
  {
    id: "atoms",
    title: { zh: "原子层", en: "Atoms" },
    blurb: {
      zh: "基础协议、稳定类型、存储与底层算法边界。",
      en: "Base protocols, stable types, storage and low-level algorithm boundaries.",
    },
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
      ? {
          id: "top",
          title: { zh: "总览", en: "Overview" },
          blurb: {
            zh: "文档中心与维护索引。",
            en: "Doc center and maintenance index.",
          },
          items: [],
        }
      : sections.find((s) => s.id === top);
  if (section) {
    section.items.push(item);
  } else {
    const created: DocSection = {
      id: top,
      title: { zh: top, en: top },
      blurb: { zh: "", en: "" },
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
