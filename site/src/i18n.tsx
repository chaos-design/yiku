import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { LANGS, type Lang } from "./docs";

const STORAGE_KEY = "yiku-site-lang";

// UI chrome strings. Doc content itself is translated in docs/en/; this covers
// the site shell (sidebar, home, gallery, pagers, empty states).
const STRINGS = {
  zh: {
    brandSub: "Docs & Artifacts",
    navigate: "导航",
    home: "首页 / 总览",
    gallery: "产物画廊",
    artifacts: "产物 (Artifacts)",
    langLabel: "English",
    langTitle: "切换到 English",
    menuOpen: "打开导航菜单",
    menuClose: "关闭导航菜单",
    brandHome: "返回首页",
    docTitle: "Yiku 文档中心",
    // Home
    homeCrumb: "Yiku · 在线文档中心",
    heroKicker: "Agent Runtime · Local Platform",
    heroTitle: "Yiku 文档中心与产物可视化",
    heroBody:
      "这是 Yiku 仓库的在线站点：左侧导航联动右侧内容区，架构 / 功能 / 原子三层文档在此渲染，仓库 artifacts/ 下的产物以内嵌可视化页面呈现。站点在构建时把 docs/ 与 artifacts/ 一起打包，GitHub Pages 与 Vercel 两种部署路径可直接运行。",
    readDocs: "阅读文档",
    browseArtifacts: "浏览全部产物",
    cardDocsKicker: "文档",
    cardDocsTitle: "文档中心",
    cardDocsBody: (n: number) => `架构层、功能层、原子层的阅读路径与维护索引，共 ${n} 篇文档。`,
    cardGalleryKicker: "产物",
    cardGalleryTitle: "产物画廊",
    cardGalleryBody: "交互式架构分享页与面试题库，以同来源 iframe 内嵌呈现。",
    cardOverviewKicker: "架构",
    cardOverviewTitle: "系统总览",
    cardOverviewBody: "核心目标、宿主模型、一次任务的主链与能力地图。",
    cardShareKicker: "可视化",
    cardShareTitle: "Yiku 架构分享页",
    cardShareBody: "面向讲解的交互式架构简报。",
    artifactsSectionTitle: "产物 (Artifacts)",
    artifactsSectionBlurb: "来自仓库 artifacts/，以内嵌可视化页面呈现",
    // Gallery
    galleryCrumb: "产物画廊",
    galleryTitle: "产物画廊",
    galleryDesc: (code: ReactNode) => (
      <>
        仓库 <code>{code}</code> 下的可视化产物。每个产物在独立的全屏内嵌视图中展示（同来源
        iframe，相对路径加载），可在此直接切换。
      </>
    ),
    // DocView
    docCrumb: "文档",
    docNotFound: "未找到文档",
    docNotFoundBody: (slug: ReactNode) => (
      <>
        没有 slug 为 <code>{slug}</code> 的文档。
      </>
    ),
    backHome: "返回文档中心",
    tocTitle: "本页目录",
    diagram: "图表",
    pagerPrev: "← 上一篇",
    pagerNext: "下一篇 →",
    pagerHome: "首页",
    pagerGallery: "产物画廊",
    // ArtifactView
    artifactCrumb: "产物",
    artifactNotFound: "未找到产物",
    artifactNotFoundBody: (slug: ReactNode) => (
      <>
        没有 slug 为 <code>{slug}</code> 的产物。
      </>
    ),
    browseAll: "浏览全部产物",
    openNewWindow: "新窗口打开 ↗",
    fullscreen: "全屏沉浸 ⛶",
    escExit: "Esc 退出",
    exitImmersive: "退出 ⤢",
    immersiveSuffix: "（沉浸模式）",
    pagerPrevArtifact: "← 上一个产物",
    pagerBack: "← 返回",
    pagerNextArtifact: "下一个产物 →",
    pagerDocs: "文档中心 →",
    pagerDocsTitle: "Yiku 文档",
  },
  en: {
    brandSub: "Docs & Artifacts",
    navigate: "Navigate",
    home: "Home / Overview",
    gallery: "Artifact Gallery",
    artifacts: "Artifacts",
    langLabel: "中文",
    langTitle: "切换到中文",
    menuOpen: "Open navigation menu",
    menuClose: "Close navigation menu",
    brandHome: "Back to home",
    docTitle: "Yiku Docs",
    // Home
    homeCrumb: "Yiku · Online Docs",
    heroKicker: "Agent Runtime · Local Platform",
    heroTitle: "Yiku Documentation & Artifact Visualizer",
    heroBody:
      "This is the online site of the Yiku repository: the sidebar drives the content pane, rendering the architecture / features / atoms doc layers, with artifacts from artifacts/ embedded as visual pages. The build bundles docs/ and artifacts/ together, ready to deploy on GitHub Pages or Vercel.",
    readDocs: "Read the docs",
    browseArtifacts: "Browse all artifacts",
    cardDocsKicker: "Docs",
    cardDocsTitle: "Documentation",
    cardDocsBody: (n: number) =>
      `Reading paths and the maintenance index across the architecture, features and atoms layers — ${n} docs in total.`,
    cardGalleryKicker: "Artifacts",
    cardGalleryTitle: "Artifact Gallery",
    cardGalleryBody:
      "Interactive architecture briefing and interview bank, embedded via a same-origin iframe.",
    cardOverviewKicker: "Architecture",
    cardOverviewTitle: "System Overview",
    cardOverviewBody:
      "Core goals, the host model, the main path of a task, and the capability map.",
    cardShareKicker: "Visual",
    cardShareTitle: "Yiku Architecture Briefing",
    cardShareBody: "An interactive architecture briefing built for walkthroughs.",
    artifactsSectionTitle: "Artifacts",
    artifactsSectionBlurb: "From the repository's artifacts/, rendered as embedded visual pages",
    // Gallery
    galleryCrumb: "Artifact Gallery",
    galleryTitle: "Artifact Gallery",
    galleryDesc: (code: ReactNode) => (
      <>
        Visual artifacts from the repository's <code>{code}</code> directory. Each artifact opens in
        its own fullscreen embedded view (same-origin iframe, relative-path loading) and can be
        switched here.
      </>
    ),
    // DocView
    docCrumb: "Docs",
    docNotFound: "Doc not found",
    docNotFoundBody: (slug: ReactNode) => (
      <>
        No doc with slug <code>{slug}</code>.
      </>
    ),
    backHome: "Back to the doc center",
    tocTitle: "On this page",
    diagram: "Diagram",
    pagerPrev: "← Previous",
    pagerNext: "Next →",
    pagerHome: "Home",
    pagerGallery: "Artifact Gallery",
    // ArtifactView
    artifactCrumb: "Artifact",
    artifactNotFound: "Artifact not found",
    artifactNotFoundBody: (slug: ReactNode) => (
      <>
        No artifact with slug <code>{slug}</code>.
      </>
    ),
    browseAll: "Browse all artifacts",
    openNewWindow: "Open in new window ↗",
    fullscreen: "Fullscreen ⛶",
    escExit: "Esc to exit",
    exitImmersive: "Exit ⤢",
    immersiveSuffix: " (immersive)",
    pagerPrevArtifact: "← Previous artifact",
    pagerBack: "← Back",
    pagerNextArtifact: "Next artifact →",
    pagerDocs: "Documentation →",
    pagerDocsTitle: "Yiku Docs",
  },
} as const;

export type Strings = (typeof STRINGS)["zh"];

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Strings;
}

const LangContext = createContext<LangContextValue | null>(null);

function initialLang(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // localStorage unavailable (privacy mode etc.) — default below.
  }
  return "zh";
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the toggle still works for the session.
    }
  }, []);

  // Keep <html lang> and the document title in sync for font shaping and
  // accessibility.
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = STRINGS[lang].docTitle;
  }, [lang]);

  const value = useMemo<LangContextValue>(
    () => ({ lang, setLang, t: STRINGS[lang] as Strings }),
    [lang, setLang],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within LangProvider");
  return ctx;
}

/** Cycle helper used by the single toggle button. */
export function nextLang(lang: Lang): Lang {
  const i = LANGS.indexOf(lang);
  return LANGS[(i + 1) % LANGS.length];
}

/** A site-owned data string authored in both site languages. */
export interface LocalizedText {
  zh: string;
  en: string;
}

/** Pick between the two language variants of a site-owned data string. */
export function pickLocalized(value: LocalizedText, lang: Lang): string {
  return value[lang];
}
