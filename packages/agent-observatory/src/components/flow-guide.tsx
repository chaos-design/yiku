import { Info, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ATOMS, type AtomLayout, DOMAINS, EDGES } from "../data/atom-layout.js";
import { ATOM_KIND_EXPLANATIONS, atomResponsibility } from "../data/atom-metadata.js";

type GuideTab = "atoms" | "observability" | "overview";
const GUIDE_TRANSITION_MS = 240;

const GUIDE_TABS: readonly {
  readonly label: string;
  readonly value: GuideTab;
}[] = [
  { label: "概览", value: "overview" },
  { label: "原子目录", value: "atoms" },
  { label: "观测", value: "observability" },
];

const ROUTE_EXPLANATIONS = [
  {
    kind: "execution",
    text: "连接调用方与被调用方，表示原子执行顺序、阶段推进或控制权转移。",
    visual: "石板灰 · 实线",
  },
  {
    kind: "data",
    text: "承载上下文、模型结果、记忆内容或评估指标，不表示控制权发生转移。",
    visual: "天蓝 · 点线",
  },
  {
    kind: "feedback",
    text: "把观察、抽取或评估结果送回上游，表达回写和反馈关系。",
    visual: "冷灰 · 虚线",
  },
  {
    kind: "persistence",
    text: "表示检查点、Trace、Trajectory 或其他持久化写入路径。",
    visual: "靛紫 · 虚线",
  },
] as const;

const STATUS_EXPLANATIONS = [
  {
    label: "灰色 · Scheduled",
    status: "scheduled",
    text: "原子已进入流程图，但当前回放位置尚未观测到开始事件。",
  },
  {
    label: "紫色 · Running",
    status: "running",
    text: "原子正在执行；Live 模式下的脉冲表示当前 Run 仍处于活跃状态。",
  },
  {
    label: "青绿色 · Completed",
    status: "completed",
    text: "原子已产生完成事件；相同颜色也用于已完成路径。",
  },
  {
    label: "红色 · Failed",
    status: "failed",
    text: "原子以错误终止；失败只描述该原子状态，不代表整个 Run 必然失败。",
  },
] as const;

const HIGHLIGHT_EXPLANATIONS = [
  {
    highlight: "selected",
    label: "青色 · Selected",
    text: "当前 Event 对应的原子或路径。选中态优先级最高，会覆盖类型色和运行状态色。",
  },
  {
    highlight: "observed",
    label: "紫色辉光 · Observed",
    text: "当前 Run 已观测到该原子；它表示存在执行事实，不等同于此刻正在运行。",
  },
  {
    highlight: "active",
    label: "紫色流光 · Active",
    text: "路径正在传递当前事件时使用，临时覆盖基础路径颜色并显示方向动画。",
  },
  {
    highlight: "complete",
    label: "青绿色 · Complete",
    text: "路径已完成时覆盖基础路径颜色；路径被选中后仍以青色 Selected 为准。",
  },
] as const;

export const FLOW_GUIDE_ATOMS: readonly AtomLayout[] = Object.freeze(
  [...new Map(ATOMS.map((atom) => [atom.key, atom])).values()].toSorted((left, right) =>
    left.key.localeCompare(right.key),
  ),
);

export interface FlowGuideProps {
  readonly defaultOpen?: boolean | undefined;
}

export function filterGuideAtoms(
  atoms: readonly AtomLayout[],
  query: string,
): readonly AtomLayout[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return atoms;
  }
  return atoms.filter((atom) => {
    const domain = DOMAINS.find((candidate) => candidate.key === atom.domain);
    return [
      atom.label,
      atom.key,
      atom.kind,
      atom.domain,
      domain?.label,
      domain?.subtitle,
      atomResponsibility(atom),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function FlowGuide({ defaultOpen = false }: FlowGuideProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [present, setPresent] = useState(defaultOpen);
  const [activeTab, setActiveTab] = useState<GuideTab>("overview");
  const [query, setQuery] = useState("");
  const animationFrameRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusOnCloseRef = useRef(true);
  const filteredAtoms = filterGuideAtoms(FLOW_GUIDE_ATOMS, query);

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    setPresent(false);
    if (restoreFocusOnCloseRef.current) {
      triggerRef.current?.focus();
    }
    restoreFocusOnCloseRef.current = true;
  }, []);

  const startClose = useCallback(
    (restoreFocus: boolean) => {
      restoreFocusOnCloseRef.current = restoreFocus;
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame?.(animationFrameRef.current);
        animationFrameRef.current = undefined;
      }
      setOpen(false);
      if (prefersReducedMotion()) {
        finishClose();
        return;
      }
      closeTimerRef.current = window.setTimeout(finishClose, GUIDE_TRANSITION_MS);
    },
    [finishClose],
  );

  const close = useCallback(() => startClose(true), [startClose]);

  const openGuide = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    restoreFocusOnCloseRef.current = true;
    setPresent(true);
    if (prefersReducedMotion() || typeof window.requestAnimationFrame !== "function") {
      setOpen(true);
      return;
    }
    setOpen(false);
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = undefined;
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        drawerRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      startClose(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open, startClose]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame?.(animationFrameRef.current);
      }
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  return (
    <span className="flow-help">
      <button
        aria-controls="flow-guide-drawer"
        aria-expanded={open}
        aria-label="Open flow guide"
        className={open ? "flow-help-trigger is-active" : "flow-help-trigger"}
        onClick={openGuide}
        ref={triggerRef}
        type="button"
      >
        <Info size={13} />
        <span className="button-label">Guide</span>
      </button>
      {present ? (
        <aside
          aria-hidden={!open}
          aria-labelledby="flow-guide-title"
          className={`flow-guide-drawer${open ? " is-open" : ""}`}
          id="flow-guide-drawer"
          onTransitionEnd={(event) => {
            if (
              !open &&
              event.currentTarget === event.target &&
              event.propertyName === "transform"
            ) {
              finishClose();
            }
          }}
          ref={drawerRef}
          role="dialog"
        >
          <header className="flow-guide-header">
            <div>
              <span className="eyebrow">ATOMIC RUNTIME REFERENCE</span>
              <h2 id="flow-guide-title">Flow Guide</h2>
              <p>原子语义、流程路径、状态与观测面板的完整说明。</p>
            </div>
            <button aria-label="Close flow guide" onClick={close} ref={closeRef} type="button">
              <X size={15} />
            </button>
          </header>
          <div aria-label="Flow Guide 分类" className="flow-guide-tabs" role="tablist">
            {GUIDE_TABS.map((tab) => (
              <button
                aria-controls={`flow-guide-panel-${tab.value}`}
                aria-selected={activeTab === tab.value}
                className={activeTab === tab.value ? "is-active" : undefined}
                id={`flow-guide-tab-${tab.value}`}
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                role="tab"
                tabIndex={activeTab === tab.value ? 0 : -1}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flow-guide-content">
            <section
              aria-labelledby="flow-guide-tab-overview"
              className="flow-guide-panel"
              hidden={activeTab !== "overview"}
              id="flow-guide-panel-overview"
              role="tabpanel"
            >
              {activeTab === "overview" ? (
                <>
                  <GuideSection
                    description="从 Prompt 进入 Session，经 Agent、Capability、Memory 链路生成回复，最后进入 Telemetry 和 Quality Gates。"
                    title="如何阅读流程"
                  >
                    <ol className="flow-guide-steps">
                      <li>Session Control 接收请求，执行 Hook，并建立阶段和检查点。</li>
                      <li>Memory Systems 召回上下文，Agent Execution 运行模型与工具循环。</li>
                      <li>Capability Orchestration 解析 Skill，并管理 Profile 与子 Agent Span。</li>
                      <li>Final Reply 形成结果，Memory Extract 写入长期记忆。</li>
                      <li>Telemetry 持久化执行事实，Quality Gates 执行质量门禁。</li>
                    </ol>
                    <p className="flow-guide-note">
                      当前目录包含 {FLOW_GUIDE_ATOMS.length} 个固定原子和 {EDGES.length}{" "}
                      条固定路径。 Deep View 会额外显示深层检索原子。
                    </p>
                  </GuideSection>

                  <GuideSection
                    description="画布按职责拆分为六个稳定区域，运行时不会重新排序固定原子。"
                    title="Runtime Domains"
                  >
                    <div className="flow-guide-domain-grid">
                      {DOMAINS.map((domain) => (
                        <article key={domain.key}>
                          <span className="flow-guide-domain-label">{domain.label}</span>
                          <strong>{domain.subtitle}</strong>
                          <p>{domainDescription(domain.key)}</p>
                        </article>
                      ))}
                    </div>
                  </GuideSection>

                  <GuideSection
                    description="Kind 描述原子的职责类型；Level 决定默认视图是否展示。"
                    title="Atom Types"
                  >
                    <div className="flow-guide-definition-list">
                      {ATOM_KIND_EXPLANATIONS.map((entry) => (
                        <div key={entry.kind}>
                          <code>{entry.kind}</code>
                          <span>{entry.text}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flow-guide-levels">
                      <p>
                        <strong>runtime</strong> 默认显示，表达主执行路径。
                      </p>
                      <p>
                        <strong>deep</strong> 仅在 Deep View 显示，表达内部检索和计算细节。
                      </p>
                      <p>
                        <strong>USER / TEST</strong> 分别表示用户任务链路与质量保障链路。
                      </p>
                    </div>
                  </GuideSection>

                  <GuideSection
                    description="基础路径同时使用颜色和线型编码关系类型；运行状态可能临时覆盖这些基础色。"
                    title="路径颜色与线型"
                  >
                    <div className="flow-guide-definition-list flow-guide-color-list">
                      {ROUTE_EXPLANATIONS.map((entry) => (
                        <div data-route-kind={entry.kind} key={entry.kind}>
                          <i className={`route-sample route-${entry.kind}`} />
                          <span className="flow-guide-color-copy">
                            <strong>
                              {entry.kind} · {entry.visual}
                            </strong>
                            <small>{entry.text}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </GuideSection>

                  <GuideSection
                    description="原子左上角的状态点描述当前回放位置下，该原子的最新生命周期状态。"
                    title="运行状态颜色"
                  >
                    <div className="flow-guide-definition-list flow-guide-color-list">
                      {STATUS_EXPLANATIONS.map((entry) => (
                        <div key={entry.status}>
                          <span className="status-samples">
                            <i data-status={entry.status} />
                          </span>
                          <span className="flow-guide-color-copy">
                            <strong>{entry.label}</strong>
                            <small>{entry.text}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </GuideSection>

                  <GuideSection
                    description="高亮色表达用户选择和实时观测，优先级高于原子类型色或路径基础色。"
                    title="交互高亮颜色"
                  >
                    <div className="flow-guide-definition-list flow-guide-color-list">
                      {HIGHLIGHT_EXPLANATIONS.map((entry) => (
                        <div key={entry.highlight}>
                          <span className="highlight-samples">
                            <i data-highlight={entry.highlight} />
                          </span>
                          <span className="flow-guide-color-copy">
                            <strong>{entry.label}</strong>
                            <small>{entry.text}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </GuideSection>
                </>
              ) : null}
            </section>

            <section
              aria-labelledby="flow-guide-tab-atoms"
              className="flow-guide-panel"
              hidden={activeTab !== "atoms"}
              id="flow-guide-panel-atoms"
              role="tabpanel"
            >
              {activeTab === "atoms" ? (
                <GuideSection
                  description="固定原子按领域分组。Key 是事件协议标识，Label 是画布显示名称。"
                  title="Atom Catalog"
                >
                  <label className="flow-guide-search">
                    <Search aria-hidden="true" size={14} />
                    <input
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder="搜索名称、Key、类型或职责"
                      type="search"
                      value={query}
                    />
                  </label>
                  <p aria-live="polite" className="flow-guide-search-result">
                    显示 {filteredAtoms.length} / {FLOW_GUIDE_ATOMS.length} 个原子
                  </p>
                  {filteredAtoms.length === 0 ? (
                    <div className="flow-guide-empty">
                      <p>没有匹配“{query.trim()}”的原子。</p>
                      <button onClick={() => setQuery("")} type="button">
                        清除搜索
                      </button>
                    </div>
                  ) : (
                    DOMAINS.flatMap((domain) => {
                      const atoms = filteredAtoms.filter((atom) => atom.domain === domain.key);
                      return atoms.length === 0
                        ? []
                        : [
                            <section className="flow-guide-atom-group" key={domain.key}>
                              <h4>{domain.label}</h4>
                              {atoms.map((atom) => (
                                <article
                                  className="flow-guide-atom"
                                  data-atom-key={atom.key}
                                  key={atom.key}
                                >
                                  <div className="flow-guide-atom-heading">
                                    <strong>{atom.label}</strong>
                                    <code>{atom.key}</code>
                                  </div>
                                  <div className="flow-guide-badges">
                                    <span className="flow-guide-badge" data-kind={atom.kind}>
                                      {atom.kind}
                                    </span>
                                    <span className="flow-guide-badge">{atom.level}</span>
                                    <span className="flow-guide-badge" data-focus={atom.focus}>
                                      {atom.focus}
                                    </span>
                                  </div>
                                  <p>{atomResponsibility(atom)}</p>
                                </article>
                              ))}
                            </section>,
                          ];
                    })
                  )}
                </GuideSection>
              ) : null}
            </section>

            <section
              aria-labelledby="flow-guide-tab-observability"
              className="flow-guide-panel"
              hidden={activeTab !== "observability"}
              id="flow-guide-panel-observability"
              role="tabpanel"
            >
              {activeTab === "observability" ? (
                <GuideSection
                  description="底部 Replay 与右侧 Events/Inspector 从同一事件序列派生，不会改变源 Run。"
                  title="Replay & Observability"
                >
                  <ul className="flow-guide-steps">
                    <li>Events 只展示功能事件；内部 Trace Receipt 不进入业务计数。</li>
                    <li>选择 Event 会同步高亮画布原子、边和 Inspector 详情。</li>
                    <li>Replay 按事件序列折叠历史；Live 会自动跟随最新事件。</li>
                    <li>Skill Worker 与子 Agent 使用相同 Instance Span 关联开始和终态。</li>
                    <li>Control Run 记录问答和 Profile 变更，不伪装成 Agent 推理 Run。</li>
                    <li>Trace 保存执行事实，Trajectory 生成面向诊断的可读投影。</li>
                    <li>Evals 消费完成后的 Snapshot，不参与 Agent 主循环。</li>
                  </ul>
                </GuideSection>
              ) : null}
            </section>
          </div>
        </aside>
      ) : null}
    </span>
  );
}

function GuideSection({
  children,
  description,
  title,
}: {
  readonly children: React.ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <section className="flow-guide-section">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function domainDescription(domain: AtomLayout["domain"]): string {
  if (domain.startsWith("agent:")) {
    return "Agent 领域步骤、数据流、验证和交付过程。";
  }
  switch (domain) {
    case "session":
      return "请求入口、Session 生命周期、阶段、任务和 Hook。";
    case "execution":
      return "Agent、模型、工具、观察、Handoff 与最终回复。";
    case "capabilities":
      return "Skill Snapshot、Session Profile、子 Agent 实例与结构化结果。";
    case "memory":
      return "记忆检索、分类、上下文注入、抽取与写入。";
    case "telemetry":
      return "事件持久化、观测降级和轨迹投影。";
    case "quality":
      return "完整性、安全、输出质量、评分与发布门禁。";
  }
  return "Agent 领域步骤、数据流、验证和交付过程。";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
