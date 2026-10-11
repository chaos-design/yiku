import type { LocalizedText } from "./i18n";

export interface ArtifactPage {
  slug: string;
  title: LocalizedText;
  description: LocalizedText;
  file: string;
  tags: LocalizedText[];
}

/**
 * The three self-contained visual artifacts shipped into the build output and
 * shown in a same-origin iframe. `file` is the dist-relative artifact path
 * (relative base is "./", so the app loads them next to index.html).
 */
export const artifactPages: ArtifactPage[] = [
  {
    slug: "architecture-share",
    title: { zh: "Yiku 架构分享页", en: "Yiku Architecture Briefing" },
    description: {
      zh: "面向讲解的交互式架构简报，覆盖 Agent 运行时、编排、权限与工程实践。",
      en: "An interactive architecture briefing for walkthroughs, covering the Agent runtime, orchestration, permissions and engineering practice.",
    },
    file: "artifacts/yiku-architecture-share.html",
    tags: [
      { zh: "架构", en: "Architecture" },
      { zh: "分享", en: "Briefing" },
      { zh: "幻灯片", en: "Slides" },
    ],
  },
  {
    slug: "interview-bank",
    title: { zh: "Yiku 面试题库", en: "Yiku Interview Bank" },
    description: {
      zh: "以 Agent 运行时为主题的面试题库，附来源指针与要点导航。",
      en: "An interview bank themed on the Agent runtime, with source pointers and key-point navigation.",
    },
    file: "artifacts/yiku-interview-bank.html",
    tags: [
      { zh: "面试", en: "Interview" },
      { zh: "题库", en: "Question Bank" },
    ],
  },
  {
    slug: "interview",
    title: { zh: "Yiku 面试控制台", en: "Yiku Interview Console" },
    description: {
      zh: "Agent 运行时面试控制台，用于逐题演练与回顾。",
      en: "An Agent-runtime interview console for question-by-question drills and review.",
    },
    file: "artifacts/yiku-interview.html",
    tags: [
      { zh: "面试", en: "Interview" },
      { zh: "演练", en: "Drills" },
    ],
  },
];

export function getArtifact(slug: string): ArtifactPage | null {
  return artifactPages.find((a) => a.slug === slug) ?? null;
}
