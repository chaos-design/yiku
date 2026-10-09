export interface ArtifactPage {
  slug: string;
  title: string;
  description: string;
  file: string;
  tags: string[];
}

/**
 * The three self-contained visual artifacts shipped into the build output and
 * shown in a same-origin iframe. `file` is the dist-relative artifact path
 * (relative base is "./", so the app loads them next to index.html).
 */
export const artifactPages: ArtifactPage[] = [
  {
    slug: "architecture-share",
    title: "Yiku 架构分享页",
    description: "面向讲解的交互式架构简报，覆盖 Agent 运行时、编排、权限与工程实践。",
    file: "artifacts/yiku-architecture-share.html",
    tags: ["架构", "分享", "幻灯片"],
  },
  {
    slug: "interview-bank",
    title: "Yiku 面试题库",
    description: "以 Agent 运行时为主题的面试题库，附来源指针与要点导航。",
    file: "artifacts/yiku-interview-bank.html",
    tags: ["面试", "题库"],
  },
  {
    slug: "interview",
    title: "Yiku 面试控制台",
    description: "Agent 运行时面试控制台，用于逐题演练与回顾。",
    file: "artifacts/yiku-interview.html",
    tags: ["面试", "演练"],
  },
];

export function getArtifact(slug: string): ArtifactPage | null {
  return artifactPages.find((a) => a.slug === slug) ?? null;
}
