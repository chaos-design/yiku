import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLOW_GUIDE_ATOMS, FlowGuide, filterGuideAtoms } from "../../src/components/flow-guide.js";

describe("FlowGuide", () => {
  it("renders a clickable trigger and an accessible detailed drawer", () => {
    const closed = renderToStaticMarkup(<FlowGuide />);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="dialog"');

    const open = renderToStaticMarkup(<FlowGuide defaultOpen />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain("aria-modal");
    expect(open).not.toContain("flow-guide-backdrop");
    expect(open).toContain('id="flow-guide-title"');
    expect(open).toContain('role="dialog"');
    expect(open).toContain('role="tablist"');
    expect(open.match(/role="tab"/gu)).toHaveLength(3);
    expect(open.match(/role="tabpanel"/gu)).toHaveLength(3);
    expect(open.match(/aria-selected="true"/gu)).toHaveLength(1);
    expect(open).toContain("概览");
    expect(open).toContain("原子目录");
    expect(open).toContain("观测");
    expect(open).toContain("如何阅读流程");
    expect(open).toContain("Runtime Domains");
    expect(open).toContain("Atom Types");
    expect(open).toContain("路径颜色与线型");
    expect(open).toContain("运行状态颜色");
    expect(open).toContain("交互高亮颜色");
    expect(open).toContain("CAPABILITY ORCHESTRATION");
    expect(open).toContain("QUALITY GATES");
    expect(open).toContain("Skill Snapshot");
    expect(open).not.toContain('placeholder="搜索名称、Key、类型或职责"');
    expect(open).not.toContain("Atom Catalog");
    expect(open).not.toContain("Replay &amp; Observability");
    expect(open.match(/data-atom-key=/gu) ?? []).toHaveLength(0);
    expect(open.match(/data-route-kind=/gu)).toHaveLength(4);
    expect(open.match(/data-status=/gu)).toHaveLength(4);
    expect(open.match(/data-highlight=/gu)).toHaveLength(4);
    expect(open).toContain("优先级最高");
    expect(open).toContain("覆盖基础路径颜色");
  });

  it("filters atoms by key, domain, kind, label, and responsibility", () => {
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, " memory.vector-search ")).toHaveLength(1);
    const memoryAtoms = filterGuideAtoms(FLOW_GUIDE_ATOMS, "MEMORY SYSTEMS");
    expect(memoryAtoms.length).toBeGreaterThan(0);
    expect(memoryAtoms.every((atom) => atom.domain === "memory")).toBe(true);
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, "凭据").map((atom) => atom.key)).toEqual([
      "eval.memory-safety",
    ]);
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, "digest").map((atom) => atom.key)).toEqual([
      "skill.resolve",
    ]);
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, "profileId").map((atom) => atom.key)).toEqual([
      "agent.execute",
      "agent.profile",
      "agent.result",
      "agent.spawn",
    ]);
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, "model").length).toBeGreaterThan(0);
    expect(filterGuideAtoms(FLOW_GUIDE_ATOMS, "不存在的原子")).toEqual([]);
  });

  it("indexes dynamic known and unknown extension kinds without a fixed domain", () => {
    const base = FLOW_GUIDE_ATOMS[0];
    if (base === undefined) {
      throw new Error("Expected fixed guide atoms.");
    }
    const extensions = [
      {
        ...base,
        domain: "missing-domain" as never,
        key: "tool.extension",
        kind: "tool" as const,
        label: "Extension Tool",
      },
      {
        ...base,
        domain: "missing-domain" as never,
        key: "custom.extension",
        kind: "custom" as never,
        label: "Custom Extension",
      },
    ];

    expect(filterGuideAtoms(extensions, "外部工具")).toHaveLength(1);
    expect(filterGuideAtoms(extensions, "运行时扩展")).toHaveLength(1);
  });
});
