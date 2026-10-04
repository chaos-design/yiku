import { Activity, Radio } from "lucide-react";
import type { RunStreamEvent } from "../types.js";

interface EventTimelineProps {
  readonly events: readonly RunStreamEvent[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  return (
    <aside aria-labelledby="timeline-heading" className="timeline-panel">
      <header className="section-heading timeline-heading">
        <div>
          <span className="eyebrow">EVENT LEDGER</span>
          <h2 id="timeline-heading">运行记录</h2>
        </div>
        <Radio aria-hidden="true" size={16} />
      </header>

      <div className="timeline-list">
        {events.length === 0 ? (
          <div className="timeline-empty">
            <Activity size={18} />
            <p>提交问题后，Agent 事件会逐条写入这里。</p>
          </div>
        ) : (
          events.map((event) => {
            const presentation = presentEvent(event);
            return (
              <article className={`timeline-event is-${presentation.tone}`} key={event.id}>
                <div className="timeline-rail">
                  <span />
                </div>
                <div className="timeline-content">
                  <header>
                    <strong>{presentation.title}</strong>
                    <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                  </header>
                  <p>{presentation.summary}</p>
                  <div className="timeline-event-footer">
                    <small>EVENT {String(event.id).padStart(3, "0")}</small>
                    <small>{eventTypeLabel(event)}</small>
                  </div>
                  <details className="timeline-details">
                    <summary>查看执行详情</summary>
                    <dl>
                      {eventDetails(event).map((detail) => (
                        <div key={detail.label}>
                          <dt>{detail.label}</dt>
                          <dd>{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </div>
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}

interface EventPresentation {
  readonly summary: string;
  readonly title: string;
  readonly tone: "active" | "failed" | "neutral" | "success";
}

interface EventDetail {
  readonly label: string;
  readonly value: string;
}

function presentEvent(event: RunStreamEvent): EventPresentation {
  if (event.type === "status") {
    const status = event.data.status;
    return {
      summary:
        event.data.error ??
        (status === "completed"
          ? "研究报告已生成"
          : status === "running"
            ? "Research Agent 已接管任务"
            : status === "cancelled"
              ? "用户终止了本次研究"
              : "等待执行资源"),
      title: statusLabel(status),
      tone:
        status === "failed"
          ? "failed"
          : status === "completed"
            ? "success"
            : status === "running"
              ? "active"
              : "neutral",
    };
  }

  if (event.type === "flow") {
    return {
      summary: event.data.payload?.summary ?? event.data.atom.label,
      title: `${event.data.atom.label} · ${phaseLabel(event.data.phase)}`,
      tone:
        event.data.phase === "error"
          ? "failed"
          : event.data.phase === "end"
            ? "success"
            : event.data.phase === "start"
              ? "active"
              : "neutral",
    };
  }

  switch (event.data.type) {
    case "agent_updated":
      return {
        summary: event.data.agentName ?? "Research Agent",
        title: "Agent 已选择",
        tone: "active",
      };
    case "reasoning":
      return {
        summary: "模型正在确定下一步研究动作",
        title: "推理",
        tone: "active",
      };
    case "tool_called":
      return {
        summary: event.data.summary ?? event.data.title ?? event.data.toolName ?? "web_search",
        title: `调用工具 · ${toolLabel(event.data.toolName)}`,
        tone: "active",
      };
    case "tool_output":
      return {
        summary: event.data.summary ?? "搜索结果已返回",
        title: `工具完成 · ${toolLabel(event.data.toolName)}`,
        tone: "success",
      };
    case "skill_resolved":
      return {
        summary: `${skillLabel(event.data.name)} 已固定为本轮执行快照`,
        title: "Skill 已解析",
        tone: "success",
      };
    case "skill_activated":
      return {
        summary: `${skillLabel(event.data.name)} 已挂载到当前 Research Turn`,
        title: "Skill 已激活",
        tone: "success",
      };
    case "skill_worker_started":
      return {
        summary: `${skillLabel(event.data.name)} 正在执行检索与证据工作流`,
        title: "Skill 执行中",
        tone: "active",
      };
    case "skill_worker_finished":
      return {
        summary: `${skillLabel(event.data.name)} ${
          event.data.status === "failed" ? "执行失败" : "执行完成"
        }`,
        title: "Skill 执行结束",
        tone: event.data.status === "failed" ? "failed" : "success",
      };
    case "usage_updated":
      return {
        summary: `${event.data.usage?.totalTokens ?? 0} total tokens`,
        title: "Usage 更新",
        tone: "neutral",
      };
    default:
      return {
        summary: event.data.summary ?? event.data.type,
        title: "Runtime 事件",
        tone: "neutral",
      };
  }
}

function eventDetails(event: RunStreamEvent): readonly EventDetail[] {
  const common: EventDetail[] = [
    { label: "事件 ID", value: String(event.id) },
    { label: "Run ID", value: event.runId },
    { label: "发生时间", value: formatDateTime(event.occurredAt) },
  ];
  if (event.type === "flow") {
    const data = event.data;
    return compactDetails([
      ...common,
      { label: "原子", value: `${data.atom.label} (${data.atom.key})` },
      { label: "阶段", value: phaseLabel(data.phase) },
      { label: "Sequence", value: String(data.sequence) },
      { label: "Instance", value: data.instance.id },
      detail("Parent", data.instance.parentId),
      detail("Iteration", data.instance.iteration),
      detail(
        "数据流",
        data.edge === undefined
          ? undefined
          : `${data.edge.fromAtomKey} → ${data.edge.toAtomKey} (${edgeKindLabel(data.edge.kind)})`,
      ),
      detail("来源实例", data.edge?.fromInstanceId),
      detail("状态码", data.payload?.code),
      detail("耗时", formatOptionalDuration(data.payload?.durationMs)),
      detail("计数", formatRecord(data.payload?.counts)),
      detail("值", formatRecord(data.payload?.values)),
    ]);
  }
  if (event.type === "status") {
    return compactDetails([
      ...common,
      { label: "状态", value: statusLabel(event.data.status) },
      detail("模型", event.data.model),
      detail("错误", event.data.error),
      detail("输出", truncate(event.data.output, 600)),
      detail("Token", formatUsage(event.data.usage)),
      detail(
        "引用校验",
        event.data.validation === undefined
          ? undefined
          : `${event.data.validation.passed ? "通过" : "失败"}；证据 ${
              event.data.validation.evidenceCount
            }；主来源 ${event.data.validation.primarySourceCount}${
              event.data.validation.diagnostics.length > 0
                ? `；${event.data.validation.diagnostics.join("；")}`
                : ""
            }`,
      ),
    ]);
  }
  return compactDetails([
    ...common,
    { label: "Runtime 类型", value: event.data.type },
    detail("Agent", event.data.agentName),
    detail("模型", event.data.model),
    detail("工具", event.data.toolName),
    detail("Call ID", event.data.callId),
    detail("Skill", event.data.name),
    detail("Skill 来源", event.data.source),
    detail("Skill Digest", event.data.digest),
    detail("Skill Target", event.data.targetId),
    detail("Skill Worker", event.data.workerId),
    detail("Skill 状态", event.data.status),
    detail("输入", formatValue(event.data.input)),
    detail("输出", formatValue(event.data.output)),
    detail("摘要", event.data.summary),
    detail("Token", formatUsage(event.data.usage)),
  ]);
}

function detail(label: string, value: unknown): EventDetail | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return {
    label,
    value: String(value),
  };
}

function compactDetails(details: readonly (EventDetail | undefined)[]): readonly EventDetail[] {
  return details.filter((item): item is EventDetail => item !== undefined);
}

function formatRecord(value: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${formatValue(item) ?? "空"}`)
    .join("；");
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncate(value.replaceAll(/\s+/gu, " ").trim(), 600);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncate(JSON.stringify(value), 600);
  } catch {
    return truncate(String(value), 600);
  }
}

function formatUsage(
  usage:
    | {
        readonly cachedInputTokens: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
      }
    | undefined,
): string | undefined {
  return usage === undefined
    ? undefined
    : `总计 ${usage.totalTokens}；输入 ${usage.inputTokens}；输出 ${usage.outputTokens}；缓存 ${usage.cachedInputTokens}`;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function formatOptionalDuration(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function eventTypeLabel(event: RunStreamEvent): string {
  return event.type === "flow"
    ? `FLOW / ${event.data.phase.toUpperCase()}`
    : event.type === "status"
      ? "RUN STATUS"
      : `RUNTIME / ${event.data.type.toUpperCase()}`;
}

function edgeKindLabel(kind: "data" | "execution" | "feedback" | "persistence"): string {
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

function toolLabel(toolName: string | undefined): string {
  const normalized = toolName?.toLowerCase().replaceAll("-", "_") ?? "";
  if (
    normalized === "web_search" ||
    normalized === "web_search_call" ||
    normalized === "websearch"
  ) {
    return "网页搜索";
  }
  if (normalized === "recordevidencetool" || normalized === "record_evidence_tool") {
    return "记录证据";
  }
  return toolName?.trim() || "未知工具";
}

function skillLabel(skill: string | undefined): string {
  switch (skill) {
    case "quick-research":
      return "Quick research";
    case "deep-research":
      return "Deep research";
    default:
      return "Research";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "已进入队列";
    case "running":
      return "研究进行中";
    case "completed":
      return "研究完成";
    case "cancelled":
      return "研究已取消";
    case "failed":
      return "研究失败";
    default:
      return status;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "start":
      return "开始";
    case "end":
      return "完成";
    case "error":
      return "失败";
    case "delta":
      return "增量";
    default:
      return phase;
  }
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
