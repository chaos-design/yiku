import {
  Activity,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  Globe2,
  LoaderCircle,
  type LucideIcon,
  Radio,
  Search,
  ShieldCheck,
  WandSparkles,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { getResearchFlowStage, RESEARCH_FLOW_STAGES } from "../data/research-flow.js";
import type { FlowNodeId, ProgressEvent, ResearchTurnSnapshot, RunStreamEvent } from "../types.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Progress } from "./ui/progress.js";

interface ResearchTraceProps {
  readonly turn: ResearchTurnSnapshot;
}

type TraceItemStatus = "active" | "completed" | "failed" | "neutral";
type TraceItemType = "evidence" | "reasoning" | "search" | "skill" | "stage" | "status" | "tool";

interface TraceDetail {
  readonly code?: boolean | undefined;
  readonly href?: string | undefined;
  readonly label: string;
  readonly value: string;
}

interface TraceItem {
  readonly completedAt?: string | undefined;
  readonly details: readonly TraceDetail[];
  readonly id: string;
  readonly occurredAt: string;
  readonly status: TraceItemStatus;
  readonly summary: string;
  readonly title: string;
  readonly type: TraceItemType;
}

const MAX_VISIBLE_ITEMS = 12;

const TRACE_PRESENTATION: Readonly<
  Record<TraceItemType, { readonly icon: LucideIcon; readonly label: string }>
> = {
  evidence: { icon: Database, label: "证据" },
  reasoning: { icon: BrainCircuit, label: "思考" },
  search: { icon: Globe2, label: "检索" },
  skill: { icon: WandSparkles, label: "Skill" },
  stage: { icon: Activity, label: "阶段" },
  status: { icon: Radio, label: "状态" },
  tool: { icon: Wrench, label: "工具" },
};

export function ResearchTrace({ turn }: ResearchTraceProps) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => projectTraceItems(turn.events), [turn.events]);
  const metrics = useMemo(() => traceMetrics(turn, items), [turn, items]);
  const visibleItems = expanded ? items : items.slice(-MAX_VISIBLE_ITEMS);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const terminal = isTerminal(turn.status);
  const currentItem = [...items].toReversed().find((item) => item.status === "active");
  const headline = terminal
    ? terminalLabel(turn.status)
    : (currentItem?.title ?? "正在建立研究计划");
  const summary = terminal
    ? `已记录 ${items.length} 条可公开运行轨迹`
    : (currentItem?.summary ?? "等待 Agent 输出第一个运行事件");

  return (
    <section aria-label="思考与执行过程" className={`research-trace is-${turn.status}`}>
      <Collapsible onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger asChild>
          <Button
            aria-label={open ? "收起思考与执行过程" : "展开思考与执行过程"}
            data-role="trace-trigger"
            variant="ghost"
          >
            <span className="research-trace-glyph">
              {turn.status === "failed" || turn.status === "cancelled" ? (
                <CircleAlert />
              ) : terminal ? (
                <Check />
              ) : (
                <BrainCircuit />
              )}
            </span>
            <span className="research-trace-heading">
              <span>思考与执行</span>
              <strong>{headline}</strong>
              <small>{summary}</small>
            </span>
            <span className="research-trace-summary">
              <Badge variant={statusVariant(turn.status)}>{statusLabel(turn.status)}</Badge>
              <span>
                {metrics.completedStages}
                <small>/{RESEARCH_FLOW_STAGES.length}</small>
              </span>
              <ChevronDown data-icon="inline-end" />
            </span>
          </Button>
        </CollapsibleTrigger>

        <Progress
          aria-label={`研究进度 ${Math.round(metrics.progress)}%`}
          value={metrics.progress}
        />

        <CollapsibleContent>
          <div className="research-trace-metrics">
            <TraceMetric label="耗时" value={metrics.duration} />
            <TraceMetric label="思考节点" value={metrics.reasoningCount} />
            <TraceMetric label="工具调用" value={metrics.toolCount} />
            <TraceMetric label="总 Token" value={formatCompactNumber(metrics.totalTokens)} />
          </div>

          <fieldset className="research-trace-legend">
            <legend className="sr-only">轨迹分类统计</legend>
            <Badge variant="secondary">
              <WandSparkles data-icon="inline-start" />
              {skillLabel(turn.skill)}
            </Badge>
            <Badge variant="outline">
              <BrainCircuit data-icon="inline-start" />
              思考 {metrics.reasoningCount}
            </Badge>
            <Badge variant="outline">
              <Search data-icon="inline-start" />
              检索 {metrics.searchCount}
            </Badge>
            <Badge variant="outline">
              <Database data-icon="inline-start" />
              证据 {turn.evidence.length}
            </Badge>
            {turn.validation !== undefined ? (
              <Badge variant={turn.validation.passed ? "secondary" : "destructive"}>
                <ShieldCheck data-icon="inline-start" />
                引用{turn.validation.passed ? "通过" : "失败"}
              </Badge>
            ) : null}
          </fieldset>

          <div className="research-trace-list">
            {visibleItems.length === 0 ? (
              <div className="research-trace-waiting">
                <LoaderCircle />
                <span>{terminal ? "本次任务没有公开运行事件" : "正在等待运行事件"}</span>
              </div>
            ) : (
              visibleItems.map((item, index) => (
                <TraceRow item={item} key={item.id} showRail={index < visibleItems.length - 1} />
              ))
            )}
          </div>

          {hiddenCount > 0 || expanded ? (
            <Button
              data-role="trace-expand"
              onClick={() => setExpanded((value) => !value)}
              size="xs"
              variant="ghost"
            >
              <ChevronDown data-icon="inline-start" />
              {expanded ? "收起早期轨迹" : `展开全部 ${items.length} 条轨迹`}
            </Button>
          ) : null}

          {turn.validation !== undefined ? <ValidationSummary turn={turn} /> : null}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function TraceMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString("zh-CN") : value}</strong>
    </div>
  );
}

function TraceRow({ item, showRail }: { readonly item: TraceItem; readonly showRail: boolean }) {
  const [open, setOpen] = useState(item.status === "failed");
  const presentation = TRACE_PRESENTATION[item.type];
  const Icon = presentation.icon;
  const duration = formatItemDuration(item);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <article className={`research-trace-item is-${item.status}`}>
        <span aria-hidden="true" className="research-trace-rail">
          {item.status === "active" ? (
            <LoaderCircle />
          ) : item.status === "failed" ? (
            <CircleAlert />
          ) : item.status === "completed" ? (
            <Check />
          ) : (
            <span />
          )}
          {showRail ? <i /> : null}
        </span>

        <div className="research-trace-item-body">
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`${open ? "收起" : "展开"}${item.title}的执行详情`}
              data-role="trace-item-trigger"
              variant="ghost"
            >
              <span className="research-trace-item-copy">
                <span>
                  <Badge variant={item.status === "failed" ? "destructive" : "outline"}>
                    <Icon data-icon="inline-start" />
                    {presentation.label}
                  </Badge>
                  <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
                  {duration === undefined ? null : (
                    <small>
                      <Clock3 />
                      {duration}
                    </small>
                  )}
                </span>
                <strong>{item.title}</strong>
                <small>{item.summary}</small>
              </span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <dl className="research-trace-details">
              {item.details.map((detail) => (
                <div key={`${detail.label}-${detail.value.slice(0, 24)}`}>
                  <dt>{detail.label}</dt>
                  {detail.href === undefined ? (
                    <dd>{detail.code ? <pre>{detail.value}</pre> : detail.value}</dd>
                  ) : (
                    <dd>
                      <a href={detail.href} rel="noreferrer" target="_blank">
                        {detail.value}
                      </a>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </div>
      </article>
    </Collapsible>
  );
}

function ValidationSummary({ turn }: { readonly turn: ResearchTurnSnapshot }) {
  const validation = turn.validation;
  if (validation === undefined) {
    return null;
  }

  return (
    <section className={`research-trace-validation is-${validation.passed ? "passed" : "failed"}`}>
      <span>
        {validation.passed ? <FileCheck2 /> : <CircleAlert />}
        <strong>{validation.passed ? "引用校验通过" : "引用校验未通过"}</strong>
      </span>
      <p>
        已核对 {validation.evidenceCount} 条证据，其中 {validation.primarySourceCount}{" "}
        条为主要来源。
      </p>
      {validation.diagnostics.length === 0 ? null : (
        <ul>
          {validation.diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function projectTraceItems(events: readonly RunStreamEvent[]): readonly TraceItem[] {
  const projected: TraceItem[] = [];
  const flowIndexByInstance = new Map<string, number>();
  const toolIndexByCallId = new Map<string, number>();
  const activeToolIndexesByName = new Map<string, number[]>();
  const orderedEvents = [...events].toSorted((left, right) => left.id - right.id);

  for (const event of orderedEvents) {
    if (event.type === "status") {
      projected.push(statusItem(event));
      continue;
    }

    if (event.type === "flow") {
      const nodeId = flowNodeId(event.data.atom.key);
      if (
        event.data.phase !== "start" &&
        event.data.phase !== "end" &&
        event.data.phase !== "error"
      ) {
        continue;
      }
      const existingIndex = flowIndexByInstance.get(event.data.instance.id);
      const existing = existingIndex === undefined ? undefined : projected[existingIndex];
      const item =
        nodeId === undefined
          ? event.data.atom.kind === "skill"
            ? skillFlowItem(event, existing)
            : undefined
          : flowItem(
              event,
              nodeId,
              getResearchFlowStage(nodeId).label,
              getResearchFlowStage(nodeId).description,
              existing,
            );
      if (item === undefined) {
        continue;
      }
      if (existingIndex === undefined) {
        flowIndexByInstance.set(event.data.instance.id, projected.length);
        projected.push(item);
      } else {
        projected[existingIndex] = item;
      }
      continue;
    }

    if (event.data.type === "reasoning") {
      const reasoningNumber = projected.filter((item) => item.type === "reasoning").length + 1;
      projected.push({
        details: commonDetails(event),
        id: `reasoning-${event.id}`,
        occurredAt: event.occurredAt,
        status: "completed",
        summary: "模型正在分析已有上下文、证据与工具结果，并决定下一步公开动作。",
        title: `思考节点 ${String(reasoningNumber).padStart(2, "0")}`,
        type: "reasoning",
      });
      continue;
    }

    if (event.data.type === "tool_called") {
      const callId = toolCallId(event.data, event.id);
      const index = projected.length;
      const toolKey = event.data.toolName?.trim() || "unknown-tool";
      toolIndexByCallId.set(callId, index);
      const indexes = activeToolIndexesByName.get(toolKey) ?? [];
      indexes.push(index);
      activeToolIndexesByName.set(toolKey, indexes);
      projected.push(toolCallItem(event, callId));
      continue;
    }

    if (event.data.type === "tool_output") {
      const explicitCallId = event.data.callId?.trim();
      const callId = explicitCallId || toolCallId(event.data, event.id);
      const toolKey = event.data.toolName?.trim() || "unknown-tool";
      const activeIndexes = activeToolIndexesByName.get(toolKey) ?? [];
      const matchedIndex =
        (explicitCallId === undefined ? activeIndexes.shift() : toolIndexByCallId.get(callId)) ??
        undefined;
      if (matchedIndex === undefined) {
        projected.push(toolOutputItem(event, callId));
      } else {
        projected[matchedIndex] = mergeToolOutput(projected[matchedIndex], event);
      }
      continue;
    }

    if (event.data.type === "agent_updated") {
      projected.push({
        details: compactDetails([
          ...commonDetails(event),
          detail("Agent", event.data.agentName),
          detail("模型", event.data.model),
        ]),
        id: `agent-${event.id}`,
        occurredAt: event.occurredAt,
        status: "completed",
        summary: event.data.agentName?.trim() || "Research Agent 已接管当前任务。",
        title: "Agent 已选择",
        type: "status",
      });
    }
  }

  const terminalStatus = orderedEvents.findLast(
    (event) =>
      event.type === "status" &&
      (event.data.status === "cancelled" ||
        event.data.status === "completed" ||
        event.data.status === "failed"),
  );
  if (terminalStatus?.type !== "status") {
    return projected;
  }

  return projected.map((item) => {
    if (item.status !== "active") {
      return item;
    }
    if (item.type === "status") {
      return { ...item, status: "completed" };
    }
    return {
      ...item,
      status: terminalStatus.data.status === "completed" ? "completed" : "failed",
      summary:
        item.type === "tool" && item.summary === "工具调用已发出，等待执行结果。"
          ? "工具调用已结束，运行时未返回可公开的结构化输出。"
          : item.summary,
    };
  });
}

function skillFlowItem(
  event: Extract<RunStreamEvent, { type: "flow" }>,
  existing: TraceItem | undefined,
): TraceItem {
  const completed = event.data.phase === "end";
  const failed = event.data.phase === "error";
  const payload = event.data.payload;
  const name = typeof payload?.values?.name === "string" ? payload.values.name : "research";
  return {
    ...(completed || failed ? { completedAt: event.occurredAt } : {}),
    details: compactDetails([
      ...(existing?.details ?? commonDetails(event)),
      { label: "Skill", value: name },
      { label: "阶段", value: skillAtomLabel(event.data.atom.key) },
      { label: "结果", value: failed ? "失败" : completed ? "完成" : "执行中" },
      detail("Digest", payload?.values?.digest, true),
      detail("Worker", payload?.values?.workerId, true),
      detail("Target", payload?.values?.targetId, true),
    ]),
    id: existing?.id ?? `flow-${event.data.instance.id}`,
    occurredAt: existing?.occurredAt ?? event.occurredAt,
    status: failed ? "failed" : completed ? "completed" : "active",
    summary:
      payload?.summary ??
      (completed
        ? `${skillLabelFromName(name)} 已完成当前研究任务。`
        : `${skillLabelFromName(name)} 正在驱动本轮检索与证据处理。`),
    title: skillAtomLabel(event.data.atom.key),
    type: "skill",
  };
}

function statusItem(event: Extract<RunStreamEvent, { type: "status" }>): TraceItem {
  const status = event.data.status;
  return {
    details: compactDetails([
      ...commonDetails(event),
      { label: "状态", value: statusLabel(status) },
      detail("模型", event.data.model),
      detail("错误", event.data.error),
      detail("Token 使用", formatUsage(event.data.usage)),
    ]),
    id: `status-${event.id}`,
    occurredAt: event.occurredAt,
    status:
      status === "failed" || status === "cancelled"
        ? "failed"
        : status === "completed"
          ? "completed"
          : status === "running"
            ? "active"
            : "neutral",
    summary:
      event.data.error ??
      (status === "queued"
        ? "任务已写入队列，等待 Research Agent 接管。"
        : status === "running"
          ? "Research Agent 已开始规划、检索与证据校验。"
          : status === "completed"
            ? "研究报告与引用校验结果已生成。"
            : status === "cancelled"
              ? "用户停止了本次研究。"
              : "研究任务执行失败。"),
    title: statusLabel(status),
    type: "status",
  };
}

function flowItem(
  event: Extract<RunStreamEvent, { type: "flow" }>,
  nodeId: FlowNodeId,
  label: string,
  description: string,
  existing: TraceItem | undefined,
): TraceItem {
  const completed = event.data.phase === "end";
  const failed = event.data.phase === "error";
  const payload = event.data.payload;
  return {
    ...(completed || failed ? { completedAt: event.occurredAt } : {}),
    details: compactDetails([
      ...(existing?.details ?? commonDetails(event)),
      { label: "阶段", value: `${label} (${event.data.atom.key})` },
      { label: "结果", value: failed ? "失败" : completed ? "完成" : "执行中" },
      detail("序列", event.data.sequence),
      detail("实例", event.data.instance.id),
      detail("迭代", event.data.instance.iteration),
      detail("统计", formatRecord(payload?.counts), true),
      detail("阶段值", formatRecord(payload?.values), true),
      detail("状态码", payload?.code),
      detail("上报耗时", formatDuration(payload?.durationMs)),
    ]),
    id: existing?.id ?? `flow-${event.data.instance.id}`,
    occurredAt: existing?.occurredAt ?? event.occurredAt,
    status: failed ? "failed" : completed ? "completed" : "active",
    summary: flowSummary(event, nodeId, description),
    title: label,
    type: flowItemType(nodeId),
  };
}

function toolCallItem(
  event: Extract<RunStreamEvent, { type: "progress" }>,
  callId: string,
): TraceItem {
  const url = extractUrl(event.data.input);
  return {
    details: compactDetails([
      ...commonDetails(event),
      detail("工具", toolLabel(event.data.toolName)),
      detail("调用 ID", event.data.callId),
      detail("执行效果", event.data.effect),
      detail("来源地址", url, false, url),
      detail("输入", formatValue(event.data.input), true),
    ]),
    id: `tool-${callId}`,
    occurredAt: event.occurredAt,
    status: "active",
    summary: toolInputSummary(event.data),
    title: toolTitle(event.data),
    type: toolItemType(event.data.toolName),
  };
}

function toolOutputItem(
  event: Extract<RunStreamEvent, { type: "progress" }>,
  callId: string,
): TraceItem {
  return {
    completedAt: event.occurredAt,
    details: compactDetails([
      ...commonDetails(event),
      detail("工具", toolLabel(event.data.toolName)),
      detail("调用 ID", event.data.callId),
      detail("输出", formatValue(event.data.output), true),
    ]),
    id: `tool-${callId}`,
    occurredAt: event.occurredAt,
    status: "completed",
    summary: toolOutputSummary(event.data),
    title: toolTitle(event.data),
    type: toolItemType(event.data.toolName),
  };
}

function mergeToolOutput(
  existing: TraceItem | undefined,
  event: Extract<RunStreamEvent, { type: "progress" }>,
): TraceItem {
  if (existing === undefined) {
    return toolOutputItem(event, toolCallId(event.data, event.id));
  }
  return {
    ...existing,
    completedAt: event.occurredAt,
    details: compactDetails([
      ...existing.details,
      detail("输出", formatValue(event.data.output), true),
    ]),
    status: "completed",
    summary: toolOutputSummary(event.data),
  };
}

function traceMetrics(turn: ResearchTurnSnapshot, items: readonly TraceItem[]) {
  const completedStages = new Set(
    turn.events.flatMap((event) => {
      if (event.type !== "flow" || event.data.phase !== "end") {
        return [];
      }
      const nodeId = flowNodeId(event.data.atom.key);
      return nodeId === undefined ? [] : [nodeId];
    }),
  ).size;
  const reasoningCount = items.filter((item) => item.type === "reasoning").length;
  const searchCount = items.filter((item) => item.type === "search").length;
  const toolCount = items.filter((item) => item.type === "tool" || item.type === "evidence").length;
  const finalEventAt = turn.events.at(-1)?.occurredAt ?? turn.updatedAt;
  const durationMs = Math.max(
    0,
    new Date(finalEventAt).getTime() - new Date(turn.createdAt).getTime(),
  );
  return {
    completedStages,
    duration: formatDuration(durationMs) ?? "0 ms",
    progress: (completedStages / RESEARCH_FLOW_STAGES.length) * 100,
    reasoningCount,
    searchCount,
    toolCount,
    totalTokens: turn.usage?.totalTokens ?? 0,
  };
}

function commonDetails(event: RunStreamEvent): readonly TraceDetail[] {
  return [
    { label: "事件 ID", value: String(event.id) },
    { label: "发生时间", value: formatDateTime(event.occurredAt) },
  ];
}

function flowSummary(
  event: Extract<RunStreamEvent, { type: "flow" }>,
  nodeId: FlowNodeId,
  description: string,
): string {
  const payload = event.data.payload;
  const summary = payload?.summary?.replaceAll(/\s+/gu, " ").trim();
  if (summary && summary.toLowerCase() !== "execute tool") {
    return summary.slice(0, 360);
  }
  const counts = payload?.counts;
  if (nodeId === "query" && typeof counts?.query === "number") {
    return `已生成检索查询 #${counts.query}，准备交给网页搜索工具。`;
  }
  if (nodeId === "search") {
    const query = payload?.values?.query;
    return event.data.phase === "start"
      ? `网页检索${typeof query === "number" ? ` #${query}` : ""}已启动。`
      : "网页检索流已结束，候选来源进入证据处理。";
  }
  if (nodeId === "citation-validate") {
    return event.data.phase === "error"
      ? "报告中的引用未全部匹配 Evidence Ledger。"
      : event.data.phase === "end"
        ? "报告引用已与 Evidence Ledger 完成逐项核对。"
        : "正在校验报告引用与证据账本的一致性。";
  }
  return event.data.phase === "start" ? `正在执行：${description}` : `已完成：${description}`;
}

function toolInputSummary(event: ProgressEvent): string {
  const input = asRecord(event.input);
  const statement = stringValue(input?.statement);
  if (statement) {
    return truncate(statement, 360);
  }
  const title = stringValue(input?.title);
  const claims = Array.isArray(input?.claims) ? input.claims.length : undefined;
  if (title) {
    return `正在记录来源「${title}」${claims === undefined ? "" : `，关联 ${claims} 条可核验主张`}。`;
  }
  if (isWebSearchTool(event.toolName)) {
    return "正在调用实时网页搜索，查找与当前研究问题相关的来源。";
  }
  const summary = cleanSummary(event.summary);
  return summary ?? "工具调用已发出，等待执行结果。";
}

function toolOutputSummary(event: ProgressEvent): string {
  const output = parseRecord(event.output);
  const evidenceId = stringValue(output?.evidenceId);
  const claimId = stringValue(output?.claimId);
  if (evidenceId) {
    const claims = numberValue(output?.claims);
    return `证据已写入 Evidence Ledger${claims === undefined ? "" : `，包含 ${claims} 条主张`}。`;
  }
  if (claimId) {
    const citations = numberValue(output?.citations);
    return `研究主张已记录${citations === undefined ? "" : `，关联 ${citations} 条引用`}。`;
  }
  if (isWebSearchTool(event.toolName)) {
    return "网页搜索已完成，结果已交给后续证据处理阶段。";
  }
  return cleanSummary(event.summary) ?? "工具执行完成，输出已进入下一阶段。";
}

function toolTitle(event: ProgressEvent): string {
  const title = event.title?.trim();
  if (title && title.toLowerCase() !== "tool" && title.toLowerCase() !== "function") {
    return title;
  }
  return toolLabel(event.toolName);
}

function toolLabel(toolName: string | undefined): string {
  const normalized = normalizeToolName(toolName);
  if (isWebSearchTool(normalized)) {
    return "网页搜索";
  }
  if (normalized === "recordevidencetool" || normalized === "record_evidence_tool") {
    return "记录证据";
  }
  if (
    normalized === "recordresearchclaimtool" ||
    normalized === "record_research_claim_tool" ||
    normalized === "recordclaimtool" ||
    normalized === "record_claim_tool"
  ) {
    return "记录研究主张";
  }
  return toolName?.trim() || "研究工具";
}

function toolItemType(toolName: string | undefined): TraceItemType {
  const normalized = normalizeToolName(toolName);
  if (isWebSearchTool(normalized)) {
    return "search";
  }
  return normalized.includes("evidence") || normalized.includes("claim") ? "evidence" : "tool";
}

function flowItemType(nodeId: FlowNodeId): TraceItemType {
  if (nodeId === "query" || nodeId === "search") {
    return "search";
  }
  if (nodeId === "evidence-record") {
    return "evidence";
  }
  return "stage";
}

function flowNodeId(atomKey: string): FlowNodeId | undefined {
  const id = atomKey.startsWith("research.") ? atomKey.slice("research.".length) : "";
  return RESEARCH_FLOW_STAGES.some((stage) => stage.id === id) ? (id as FlowNodeId) : undefined;
}

function skillAtomLabel(atomKey: string): string {
  switch (atomKey) {
    case "skill.resolve":
      return "解析 Skill";
    case "skill.activate":
      return "激活 Skill";
    case "skill.execute":
      return "执行 Skill";
    default:
      return "Skill";
  }
}

function skillLabel(skill: ResearchTurnSnapshot["skill"]): string {
  return skillLabelFromName(skill);
}

function skillLabelFromName(skill: string): string {
  switch (skill) {
    case "quick-research":
      return "Quick research";
    case "deep-research":
      return "Deep research";
    default:
      return "Research";
  }
}

function toolCallId(event: ProgressEvent, fallback: number): string {
  return event.callId?.trim() || `${event.toolName ?? "tool"}-${fallback}`;
}

function cleanSummary(value: string | undefined): string | undefined {
  const summary = value?.replaceAll(/\s+/gu, " ").trim();
  if (
    !summary ||
    summary.toLowerCase() === "execute tool" ||
    /^(?:completed|finished|result)?\s*[[{]/iu.test(summary)
  ) {
    return undefined;
  }
  return truncate(summary, 360);
}

function extractUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = stringValue(record?.url);
  if (direct) {
    return direct;
  }
  const citations = record?.citation_urls;
  return Array.isArray(citations)
    ? citations.find((item): item is string => typeof item === "string")
    : undefined;
}

function parseRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function detail(
  label: string,
  value: unknown,
  code = false,
  href?: string,
): TraceDetail | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return {
    code,
    ...(href !== undefined ? { href } : {}),
    label,
    value: String(value),
  };
}

function compactDetails(details: readonly (TraceDetail | undefined)[]): readonly TraceDetail[] {
  const seen = new Set<string>();
  return details.filter((item): item is TraceDetail => {
    if (item === undefined) {
      return false;
    }
    const key = `${item.label}:${item.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = parseRecord(value);
    return parsed === undefined
      ? truncate(value, 1_800)
      : truncate(JSON.stringify(parsed, null, 2), 1_800);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncate(JSON.stringify(value, null, 2), 1_800);
  } catch {
    return truncate(String(value), 1_800);
  }
}

function formatRecord(value: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return value === undefined ? undefined : formatValue(value);
}

function formatUsage(usage: ResearchTurnSnapshot["usage"]): string | undefined {
  return usage === undefined
    ? undefined
    : `总计 ${usage.totalTokens.toLocaleString("zh-CN")}；输入 ${usage.inputTokens.toLocaleString(
        "zh-CN",
      )}；输出 ${usage.outputTokens.toLocaleString("zh-CN")}；缓存 ${usage.cachedInputTokens.toLocaleString(
        "zh-CN",
      )}`;
}

function formatItemDuration(item: TraceItem): string | undefined {
  if (item.completedAt === undefined) {
    return undefined;
  }
  const duration = new Date(item.completedAt).getTime() - new Date(item.occurredAt).getTime();
  return formatDuration(Math.max(0, duration));
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < 1_000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function normalizeToolName(toolName: string | undefined): string {
  return toolName?.toLowerCase().replaceAll("-", "_") ?? "";
}

function isWebSearchTool(toolName: string | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    normalized === "web_search" || normalized === "web_search_call" || normalized === "websearch"
  );
}

function statusVariant(
  status: ResearchTurnSnapshot["status"],
): "destructive" | "outline" | "secondary" {
  if (status === "failed" || status === "cancelled") {
    return "destructive";
  }
  return status === "completed" ? "secondary" : "outline";
}

function statusLabel(status: ResearchTurnSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "等待执行";
    case "running":
      return "研究进行中";
    case "completed":
      return "研究完成";
    case "failed":
      return "研究失败";
    case "cancelled":
      return "研究已停止";
  }
}

function terminalLabel(status: ResearchTurnSnapshot["status"]): string {
  switch (status) {
    case "completed":
      return "研究、取证与引用校验已完成";
    case "failed":
      return "研究执行结束，但存在失败项";
    case "cancelled":
      return "研究任务已停止";
    default:
      return "研究任务执行中";
  }
}

function isTerminal(status: ResearchTurnSnapshot["status"]): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}
