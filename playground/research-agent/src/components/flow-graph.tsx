import {
  BookOpenCheck,
  BrainCircuit,
  FileCheck2,
  FileSearch,
  ListTree,
  MoveRight,
  RotateCw,
  ScanSearch,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  getResearchFlowStage,
  RESEARCH_FLOW_GROUPS,
  RESEARCH_FLOW_STAGES,
  researchFlowStatusLabel,
} from "../data/research-flow.js";
import type { FlowEdgeView, FlowNodeId, FlowNodeStatus, FlowNodeView } from "../types.js";

interface FlowGraphProps {
  readonly edges: readonly FlowEdgeView[];
  readonly nodes: readonly FlowNodeView[];
}

const ICONS: Readonly<
  Record<FlowNodeId, ComponentType<{ readonly size?: number; readonly strokeWidth?: number }>>
> = {
  "citation-validate": ShieldCheck,
  corroborate: SearchCheck,
  "evidence-record": BookOpenCheck,
  plan: ListTree,
  query: FileSearch,
  report: FileCheck2,
  search: ScanSearch,
  synthesize: BrainCircuit,
};

export function FlowGraph({ edges, nodes }: FlowGraphProps) {
  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const completedCount = RESEARCH_FLOW_STAGES.filter(
    (stage) => statusById.get(stage.id) === "completed",
  ).length;
  const currentStage =
    RESEARCH_FLOW_STAGES.find((stage) => nodeById.get(stage.id)?.executionActive) ??
    RESEARCH_FLOW_STAGES.find((stage) => {
      const status = statusById.get(stage.id);
      return status === "active" || status === "failed";
    });
  const evidenceGroup = RESEARCH_FLOW_GROUPS.find((group) => group.id === "evidence");
  const evidenceActive =
    evidenceGroup?.nodeIds.some((id) => nodeById.get(id)?.executionActive) ?? false;
  const progressLabel =
    currentStage?.label ??
    (completedCount === RESEARCH_FLOW_STAGES.length ? "流程完成" : "等待开始");
  const latestEdge =
    edges.findLast((edge) => edge.flowing) ??
    edges.findLast((edge) => edge.status === "active") ??
    edges.findLast((edge) => edge.status === "failed") ??
    edges.at(-1);
  const evidenceEdgeStatus = latestStatus(
    edges.filter(
      (edge) =>
        evidenceGroup?.nodeIds.includes(edge.from) === true &&
        evidenceGroup.nodeIds.includes(edge.to),
    ),
  );
  const evidenceFlowing = edges.some(
    (edge) =>
      edge.flowing &&
      evidenceGroup?.nodeIds.includes(edge.from) === true &&
      evidenceGroup.nodeIds.includes(edge.to),
  );

  return (
    <section aria-labelledby="flow-heading" className="flow-section">
      <header className="section-heading flow-heading">
        <div>
          <span className="eyebrow">RESEARCH CIRCUIT</span>
          <h2 id="flow-heading">证据如何成为报告</h2>
        </div>
        <div aria-live="polite" className="flow-progress-summary">
          <strong>
            {String(completedCount).padStart(2, "0")}
            <small>/08</small>
          </strong>
          <span>{progressLabel}</span>
        </div>
      </header>

      <div aria-hidden="true" className="flow-signal-line">
        <span style={{ width: `${(completedCount / RESEARCH_FLOW_STAGES.length) * 100}%` }} />
      </div>

      <div aria-live="polite" className={`flow-current-route is-${latestEdge?.status ?? "idle"}`}>
        <span>DATA FLOW</span>
        {latestEdge === undefined ? (
          <strong>等待第一条执行边</strong>
        ) : (
          <strong>
            {getResearchFlowStage(latestEdge.from).label}
            <MoveRight aria-hidden="true" size={11} />
            {getResearchFlowStage(latestEdge.to).label}
          </strong>
        )}
        <small>
          {latestEdge === undefined
            ? "Atomic Flow 将在这里显示真实数据流向"
            : `${edgeKindLabel(latestEdge.kind)} · #${latestEdge.sequence} · ${researchFlowStatusLabel(
                latestEdge.status,
              )}`}
        </small>
      </div>

      <div className="flow-circuit">
        <FlowRail edges={edges} groupId="prepare" nodeIds={["plan", "query"]} nodeById={nodeById} />

        <FlowTransfer from="query" route={routeView(edges, "query", "search")} to="search" />

        <section
          className={`flow-loop${evidenceActive ? " is-active" : ""}${
            evidenceFlowing ? " is-flowing" : ""
          } is-edge-${evidenceEdgeStatus}`}
          data-group="evidence"
        >
          <header className="flow-loop-heading">
            <div>
              <span>02 / ITERATIVE</span>
              <strong>证据回路</strong>
              <small>检索、取证、核验，直到证据足够</small>
            </div>
            <em>
              <RotateCw size={10} />
              LOOP
            </em>
          </header>
          <div className="flow-loop-orbit">
            <span aria-hidden="true" className={`flow-orbit-path is-${evidenceEdgeStatus}`} />
            <span aria-hidden="true" className="flow-orbit-pulse" />
            <CompactNode id="search" node={nodeById.get("search")} />
            <CompactNode id="evidence-record" node={nodeById.get("evidence-record")} />
            <CompactNode id="corroborate" node={nodeById.get("corroborate")} />
            <div aria-hidden="true" className="flow-loop-core">
              <RotateCw size={16} strokeWidth={1.5} />
              <span>EVIDENCE</span>
            </div>
          </div>
          <p className="flow-loop-caption">
            <span>搜索</span>
            <MoveRight aria-hidden="true" size={9} />
            <span>记录证据</span>
            <MoveRight aria-hidden="true" size={9} />
            <span>交叉核验</span>
          </p>
        </section>

        <FlowTransfer
          from={latestIncomingEdge(edges, "synthesize")?.from ?? "corroborate"}
          route={latestIncomingEdge(edges, "synthesize")}
          to="synthesize"
        />

        <FlowRail
          edges={edges}
          groupId="deliver"
          nodeIds={["synthesize", "citation-validate", "report"]}
          nodeById={nodeById}
        />
      </div>
    </section>
  );
}

function FlowRail({
  edges,
  groupId,
  nodeIds,
  nodeById,
}: {
  readonly edges: readonly FlowEdgeView[];
  readonly groupId: "deliver" | "prepare";
  readonly nodeIds: readonly FlowNodeId[];
  readonly nodeById: ReadonlyMap<FlowNodeId, FlowNodeView>;
}) {
  const group = RESEARCH_FLOW_GROUPS.find((candidate) => candidate.id === groupId);
  if (group === undefined) {
    return null;
  }

  return (
    <section className="flow-rail-group" data-group={groupId}>
      <header className="flow-rail-heading">
        <span>{groupId === "prepare" ? "01" : "03"}</span>
        <div>
          <strong>{group.label}</strong>
          <small>{group.description}</small>
        </div>
      </header>
      <ol className="flow-rail">
        {nodeIds.map((nodeId, index) => {
          const stage = getResearchFlowStage(nodeId);
          const node = nodeById.get(nodeId);
          const status = node?.status ?? "idle";
          const Icon = ICONS[nodeId];
          return (
            <li key={nodeId}>
              <article
                aria-current={status === "active" ? "step" : undefined}
                aria-label={`${stage.label}：${researchFlowStatusLabel(status)}`}
                className={`flow-node is-${status}${
                  node?.executionActive ? " is-execution-active" : ""
                }`}
              >
                <span aria-hidden="true" className="flow-node-scan" />
                <span className="flow-node-index">{stage.index}</span>
                <span className="flow-node-icon">
                  <Icon size={16} strokeWidth={1.7} />
                </span>
                <span className="flow-node-copy">
                  <strong>{stage.label}</strong>
                  <small>{stage.description}</small>
                </span>
                <span className="flow-node-status">{researchFlowStatusLabel(status)}</span>
              </article>
              {index < nodeIds.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={routeClass(
                    "flow-rail-link",
                    routeView(edges, nodeId, nodeIds[index + 1] ?? nodeId),
                  )}
                >
                  <i />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CompactNode({
  id,
  node,
}: {
  readonly id: FlowNodeId;
  readonly node?: FlowNodeView | undefined;
}) {
  const stage = getResearchFlowStage(id);
  const Icon = ICONS[id];
  const status = node?.status ?? "idle";

  return (
    <article
      aria-current={status === "active" ? "step" : undefined}
      aria-label={`${stage.label}：${researchFlowStatusLabel(status)}`}
      className={`flow-loop-node is-${status} is-${id}${
        node?.executionActive ? " is-execution-active" : ""
      }`}
    >
      <span className="flow-loop-node-icon">
        <Icon size={15} strokeWidth={1.7} />
      </span>
      <span>
        <strong>{stage.label}</strong>
        <small>{stage.index}</small>
      </span>
    </article>
  );
}

function FlowTransfer({
  from,
  route,
  to,
}: {
  readonly from: FlowNodeId;
  readonly route?: FlowEdgeView | undefined;
  readonly to: FlowNodeId;
}) {
  const status = route?.status ?? "idle";
  return (
    <div
      aria-label={`${getResearchFlowStage(from).label}流向${getResearchFlowStage(to).label}：${researchFlowStatusLabel(
        status,
      )}`}
      className={routeClass("flow-transfer is-down", route)}
      role="img"
    >
      <span />
      <i />
    </div>
  );
}

function routeView(
  edges: readonly FlowEdgeView[],
  from: FlowNodeId,
  to: FlowNodeId,
): FlowEdgeView | undefined {
  return edges.findLast((edge) => edge.from === from && edge.to === to);
}

function routeClass(prefix: string, route: FlowEdgeView | undefined): string {
  return `${prefix} is-${route?.status ?? "idle"}${route?.flowing ? " is-flowing" : ""}`;
}

function latestIncomingEdge(
  edges: readonly FlowEdgeView[],
  to: FlowNodeId,
): FlowEdgeView | undefined {
  return edges.findLast((edge) => edge.to === to);
}

function latestStatus(edges: readonly FlowEdgeView[]): FlowNodeStatus {
  return (
    edges.findLast((edge) => edge.status === "active")?.status ??
    edges.findLast((edge) => edge.status === "failed")?.status ??
    edges.at(-1)?.status ??
    "idle"
  );
}

function edgeKindLabel(kind: FlowEdgeView["kind"]): string {
  switch (kind) {
    case "data":
      return "数据";
    case "execution":
      return "执行";
    case "feedback":
      return "反馈";
    case "persistence":
      return "持久化";
  }
}
