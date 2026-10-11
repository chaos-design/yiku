import { useEffect, useState } from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "yiku-site-lang";

function loadLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // localStorage can be unavailable (e.g. sandboxed iframe); default below.
  }
  return "zh";
}

let currentLang: Lang = loadLang();

const listeners = new Set<() => void>();

function applyLang(lang: Lang): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = lang === "zh" ? "Yiku 文档中心" : "Yiku Docs";
}

function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Best effort only; the in-memory language still applies.
  }
  applyLang(lang);
  for (const listener of listeners) listener();
}

export function toggleLang(): void {
  setLang(currentLang === "zh" ? "en" : "zh");
}

export function useLang(): Lang {
  const [lang, setLocal] = useState<Lang>(currentLang);
  useEffect(() => {
    const onChange = () => setLocal(currentLang);
    listeners.add(onChange);
    applyLang(currentLang);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return lang;
}

/** UI strings for the site chrome. Doc bodies stay as authored in docs/. */
const strings = {
  zh: {
    "nav.navigate": "导航",
    "nav.home": "首页 / 总览",
    "nav.gallery": "产物画廊",
    "nav.artifacts": "产物 (Artifacts)",
    "sidebar.foot.pre": "文档与产物由本仓库在构建时内联打包；GitHub Pages 与 Vercel 均可直接部署 ",
    "sidebar.foot.post": "。",
    "home.crumb": "Yiku · 在线文档中心",
    "hero.title": "Yiku 文档中心与产物可视化",
    "hero.desc":
      "这是 Yiku 仓库的在线站点：左侧导航联动右侧内容区，架构 / 功能 / 原子三层文档在此渲染，仓库 artifacts/ 下的产物以内嵌可视化页面呈现。站点在构建时把 docs/ 与 artifacts/ 一起打包，GitHub Pages 与 Vercel 两种部署路径可直接运行。",
    "hero.primary": "阅读文档中心",
    "hero.secondary": "浏览全部产物",
    "card.docs.kicker": "文档",
    "card.docs.title": "文档中心",
    "card.docs.body": "架构层、功能层、原子层的阅读路径与维护索引，共 {n} 篇文档。",
    "card.gallery.kicker": "产物",
    "card.gallery.title": "产物画廊",
    "card.gallery.body": "交互式架构分享页与面试题库，以同来源 iframe 内嵌呈现。",
    "card.overview.kicker": "架构",
    "card.overview.title": "系统总览",
    "card.overview.body": "核心目标、宿主模型、一次任务的主链与能力地图。",
    "card.share.kicker": "可视化",
    "card.share.title": "Yiku 架构分享页",
    "card.share.body": "面向讲解的交互式架构简报。",
    "home.artifacts.title": "产物 (Artifacts)",
    "home.artifacts.blurb": "来自仓库 artifacts/，以内嵌可视化页面呈现",
    "gallery.crumb": "产物画廊",
    "gallery.title": "产物画廊",
    "gallery.desc":
      "仓库 artifacts/ 下的可视化产物。每个产物在独立的全屏内嵌视图中展示（同来源 iframe，相对路径加载），可在此直接切换。",
    "artifact.crumb": "产物",
    "artifact.notfound.title": "未找到产物",
    "artifact.notfound.desc": "没有 slug 为 {slug} 的产物。",
    "artifact.notfound.link": "浏览全部产物",
    "artifact.open": "新窗口打开 ↗",
    "artifact.fullscreen": "全屏沉浸 ⛶",
    "artifact.exitEsc": "Esc 退出",
    "artifact.exit": "退出 ⤢",
    "artifact.immersiveSuffix": "（沉浸模式）",
    "pager.prev": "← 上一个产物",
    "pager.next": "下一个产物 →",
    "pager.back": "← 返回",
    "pager.gallery": "产物画廊",
    "pager.docsHome": "文档中心 →",
    "pager.docsHomeTitle": "Yiku 文档",
    "doc.notfound.crumb": "文档",
    "doc.notfound.title": "未找到文档",
    "doc.notfound.desc": "没有 slug 为 {slug} 的文档。",
    "doc.notfound.link": "返回文档中心",
    "doc.loading": "渲染中…",
    "doc.toc": "本页目录",
    "doc.diagram": "图表",
    "doc.prev": "← 上一篇",
    "doc.next": "下一篇 →",
    "doc.prevHome": "首页",
    "lang.toggle": "EN",
    "lang.toggleTitle": "Switch to English",
  },
  en: {
    "nav.navigate": "Navigate",
    "nav.home": "Home / Overview",
    "nav.gallery": "Artifact Gallery",
    "nav.artifacts": "Artifacts",
    "sidebar.foot.pre":
      "Docs and artifacts are bundled from this repository at build time; both GitHub Pages and Vercel can deploy ",
    "sidebar.foot.post": " directly.",
    "home.crumb": "Yiku · Online Docs",
    "hero.title": "Yiku Docs & Artifact Visualization",
    "hero.desc":
      "This is the online site of the Yiku repository: the sidebar drives the content pane, rendering the architecture / features / atoms doc layers, with artifacts from artifacts/ embedded as visual pages. The build bundles docs/ and artifacts/ together, ready to deploy on GitHub Pages or Vercel.",
    "hero.primary": "Read the docs",
    "hero.secondary": "Browse artifacts",
    "card.docs.kicker": "Docs",
    "card.docs.title": "Doc Center",
    "card.docs.body":
      "Reading paths and maintenance index across the architecture, features and atoms layers — {n} documents.",
    "card.gallery.kicker": "Artifacts",
    "card.gallery.title": "Artifact Gallery",
    "card.gallery.body":
      "Interactive architecture briefing and interview bank, embedded via same-origin iframe.",
    "card.overview.kicker": "Architecture",
    "card.overview.title": "System Overview",
    "card.overview.body":
      "Core goals, host model, the main path of one task, and the capability map.",
    "card.share.kicker": "Visual",
    "card.share.title": "Yiku Architecture Briefing",
    "card.share.body": "An interactive architecture briefing built for walkthroughs.",
    "home.artifacts.title": "Artifacts",
    "home.artifacts.blurb": "From the repository's artifacts/, embedded as visual pages",
    "gallery.crumb": "Artifact Gallery",
    "gallery.title": "Artifact Gallery",
    "gallery.desc":
      "Visual artifacts from the repository's artifacts/ directory. Each artifact opens in its own fullscreen embedded view (same-origin iframe, relative-path loading) and can be switched here.",
    "artifact.crumb": "Artifact",
    "artifact.notfound.title": "Artifact Not Found",
    "artifact.notfound.desc": "No artifact with slug {slug}.",
    "artifact.notfound.link": "Browse all artifacts",
    "artifact.open": "Open in new tab ↗",
    "artifact.fullscreen": "Fullscreen ⛶",
    "artifact.exitEsc": "Esc to exit",
    "artifact.exit": "Exit ⤢",
    "artifact.immersiveSuffix": " (immersive)",
    "pager.prev": "← Previous artifact",
    "pager.next": "Next artifact →",
    "pager.back": "← Back",
    "pager.gallery": "Artifact Gallery",
    "pager.docsHome": "Doc Center →",
    "pager.docsHomeTitle": "Yiku Docs",
    "doc.notfound.crumb": "Docs",
    "doc.notfound.title": "Document Not Found",
    "doc.notfound.desc": "No document with slug {slug}.",
    "doc.notfound.link": "Back to the doc center",
    "doc.loading": "Rendering…",
    "doc.toc": "On this page",
    "doc.diagram": "Diagram",
    "doc.prev": "← Previous",
    "doc.next": "Next →",
    "doc.prevHome": "Home",
    "lang.toggle": "中文",
    "lang.toggleTitle": "切换到中文",
  },
} as const;

export type StringKey = keyof (typeof strings)["zh"];

/** Translate a UI string for the current language; {name} placeholders are
 * replaced from `vars`. */
export function useT(): (key: StringKey, vars?: Record<string, string | number>) => string {
  const lang = useLang();
  return (key, vars) => {
    let text: string = strings[lang][key];
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

/** A site-owned data string authored in both site languages. */
export interface LocalizedText {
  zh: string;
  en: string;
}

/** Pick between the two language variants of a site-owned data string. */
export function pickLocalized(value: { zh: string; en: string }, lang: Lang): string {
  return value[lang];
}
