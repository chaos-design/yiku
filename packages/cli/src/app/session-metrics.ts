import type {
  AgentContextComposition,
  AgentProgressEvent,
  AgentUsage,
  ContextWindowSource,
} from "@yiku/agent-orchestrator";

type ToolCallEvent = Extract<AgentProgressEvent, { readonly type: "tool_called" }>;
type ToolOutputEvent = Extract<AgentProgressEvent, { readonly type: "tool_output" }>;

export interface ModelUsageSummary {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
}

export interface ToolUsageSummary {
  readonly calls: number;
  readonly durationMs: number;
  readonly errors: number;
  readonly name: string;
}

export interface TaskUsageSummary {
  readonly blocked: number;
  readonly completed: number;
  readonly inProgress: number;
  readonly pending: number;
}

export interface SessionSummary {
  readonly addedLines: number;
  readonly apiDurationMs: number;
  readonly checkpointCount: number;
  readonly contextWindow?: number | undefined;
  readonly model: string;
  readonly pauseReason?: string | undefined;
  readonly peakInputTokens: number;
  readonly removedLines: number;
  readonly sessionId: string;
  readonly stageCount: number;
  readonly tasks: TaskUsageSummary;
  readonly toolCalls: readonly ToolUsageSummary[];
  readonly usageByModel: readonly ModelUsageSummary[];
  readonly wallDurationMs: number;
}

export interface SessionMetricsSnapshot {
  readonly compactAtContextRatio?: number | undefined;
  readonly contextComposition?: AgentContextComposition | undefined;
  readonly contextTokens: number;
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly model: string;
  readonly peakInputTokens: number;
  readonly sessionId: string;
  readonly tasks: TaskUsageSummary;
  readonly toolCalls: readonly ToolUsageSummary[];
  readonly usageByModel: readonly ModelUsageSummary[];
  readonly wallDurationMs: number;
}

export type ContextUsageCategoryKey =
  | "messages"
  | "procedure-memory"
  | "scenario-memory"
  | "semantic-memory"
  | "skills"
  | "system-prompt"
  | "system-tools"
  | "working-memory";

export interface ContextUsageCategory {
  readonly key: ContextUsageCategoryKey;
  readonly label: string;
  readonly tokens: number;
}

export interface ContextUsageDetails {
  readonly autocompactBufferTokens: number;
  readonly categories: readonly ContextUsageCategory[];
  readonly contextWindow?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
  readonly freeTokens?: number | undefined;
  readonly model: string;
  readonly usedTokens: number;
}

export interface SessionMetricsOptions {
  readonly model: string;
  readonly sessionId: string;
  readonly startedAtMs: number;
}

interface ActiveTool {
  readonly input?: unknown;
  readonly name: string;
  readonly startedAtMs: number;
  readonly toolName: string;
}

interface RunUsageSnapshot {
  readonly model: string;
  readonly usage: AgentUsage;
}

interface MutableModelUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface MutableToolUsage {
  calls: number;
  durationMs: number;
  errors: number;
}

export class SessionMetrics {
  private readonly activeTools = new Map<string, ActiveTool>();
  private addedLines = 0;
  private checkpointCount = 0;
  private readonly contextUsageByRun = new Map<number, number>();
  private contextTokens = 0;
  private contextWindow: number | undefined;
  private contextWindowSource: ContextWindowSource | undefined;
  private compactAtContextRatio: number | undefined;
  private contextComposition: AgentContextComposition | undefined;
  private readonly modelUsage = new Map<string, MutableModelUsage>();
  private model: string;
  private pauseReason?: string | undefined;
  private peakInputTokens = 0;
  private readonly runStartedAt = new Map<number, number>();
  private readonly runUsage = new Map<number, RunUsageSnapshot>();
  private runDurationMs = 0;
  private readonly sessionId: string;
  private readonly startedAtMs: number;
  private stageCount = 0;
  private summary: SessionSummary | undefined;
  private readonly toolUsage = new Map<string, MutableToolUsage>();
  private tasks: TaskUsageSummary = {
    blocked: 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
  };
  private removedLines = 0;

  public constructor(options: SessionMetricsOptions) {
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.startedAtMs = options.startedAtMs;
  }

  public updateContext(
    model: string,
    contextWindow?: number | undefined,
    contextComposition?: AgentContextComposition | undefined,
    compactAtContextRatio?: number | undefined,
    contextWindowSource?: ContextWindowSource | undefined,
  ): void {
    if (this.summary) {
      return;
    }

    this.model = model;
    this.contextWindow = contextWindow;
    this.contextWindowSource = contextWindowSource;
    this.contextComposition = contextComposition;
    this.compactAtContextRatio = compactAtContextRatio;
  }

  public startRun(runId: number, startedAtMs: number): void {
    if (!this.summary && !this.runStartedAt.has(runId)) {
      this.runStartedAt.set(runId, startedAtMs);
    }
  }

  public finishRun(runId: number, finishedAtMs: number): void {
    if (this.summary) {
      return;
    }

    const startedAtMs = this.runStartedAt.get(runId);

    if (startedAtMs === undefined) {
      return;
    }

    this.runDurationMs += Math.max(0, finishedAtMs - startedAtMs);
    this.runStartedAt.delete(runId);
  }

  public recordUsage(runId: number, model: string, usage: AgentUsage): void {
    if (this.summary) {
      return;
    }

    const previous = this.runUsage.get(runId);

    if (previous) {
      this.applyUsage(previous.model, previous.usage, -1);
    }

    this.applyUsage(model, usage, 1);
    this.runUsage.set(runId, { model, usage });
    const previousContextTokens = this.contextUsageByRun.get(runId) ?? 0;
    this.contextTokens = Math.max(
      0,
      this.contextTokens - previousContextTokens + usage.peakInputTokens,
    );
    this.contextUsageByRun.set(runId, usage.peakInputTokens);
    this.peakInputTokens = Math.max(this.peakInputTokens, this.contextTokens);
  }

  public resetContext(): void {
    if (!this.summary) {
      this.contextUsageByRun.clear();
      this.contextTokens = 0;
    }
  }

  public recordToolCall(event: ToolCallEvent, startedAtMs: number): void {
    if (this.summary) {
      return;
    }

    const callId = event.callId ?? "legacy";
    this.finishTool(callId, startedAtMs);
    const name = getToolDisplayName(event.toolName, event.input, event.title);
    const usage = this.getToolUsage(name);
    usage.calls += 1;
    this.activeTools.set(callId, {
      ...(event.input !== undefined ? { input: event.input } : {}),
      name,
      startedAtMs,
      toolName: event.toolName,
    });
  }

  public recordToolOutput(event: ToolOutputEvent, finishedAtMs: number): void {
    if (this.summary) {
      return;
    }

    const callId = event.callId ?? "legacy";
    const activeTool = this.activeTools.get(callId);

    if (!activeTool || activeTool.toolName !== event.toolName) {
      this.finishTool(callId, finishedAtMs);
      return;
    }

    const failed = isToolError(event.output);
    this.finishTool(callId, finishedAtMs, failed);

    if (!failed && event.toolName === "textEditorTool") {
      this.recordCodeChanges(activeTool.input);
    }
  }

  public recordRuntimeEvent(event: AgentProgressEvent): void {
    if (this.summary) {
      return;
    }

    switch (event.type) {
      case "checkpoint_saved":
        this.checkpointCount += 1;
        return;
      case "stage_started":
        this.stageCount += 1;
        return;
      case "stage_finished":
        if (event.outcome === "paused") {
          this.pauseReason = event.reason ?? "paused";
        }
        return;
      case "task_snapshot":
        this.tasks = {
          blocked: event.blocked,
          completed: event.completed,
          inProgress: event.inProgress,
          pending: event.pending,
        };
        return;
      case "agent_updated":
      case "agent_profile_changed":
      case "evaluation_finished":
      case "handoff":
      case "memory_operation":
      case "message_delta":
      case "prompt_risk_detected":
      case "reasoning":
      case "runtime_boundary_changed":
      case "session_cancelled":
      case "session_failed":
      case "session_finished":
      case "session_resumed":
      case "skill_activated":
      case "skill_resolved":
      case "skill_worker_finished":
      case "skill_worker_started":
      case "subagent_output":
      case "subagent_result":
      case "subagent_spawned":
      case "tool_called":
      case "tool_output":
      case "usage_updated":
      case "user_question_cancelled":
      case "user_question_requested":
      case "user_question_resolved":
        return;
      case "context_compacted":
        this.resetContext();
        return;
    }
  }

  public buildSummary(finishedAtMs: number): SessionSummary {
    if (this.summary) {
      return this.summary;
    }

    for (const runId of this.runStartedAt.keys()) {
      this.finishRun(runId, finishedAtMs);
    }
    this.finishActiveTool(finishedAtMs);

    const toolCalls = [...this.toolUsage].map(([name, usage]) => ({
      calls: usage.calls,
      durationMs: usage.durationMs,
      errors: usage.errors,
      name,
    }));
    const toolDurationMs = toolCalls.reduce((total, tool) => total + tool.durationMs, 0);

    this.summary = {
      addedLines: this.addedLines,
      apiDurationMs: Math.max(0, this.runDurationMs - toolDurationMs),
      checkpointCount: this.checkpointCount,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      model: this.model,
      ...(this.pauseReason !== undefined ? { pauseReason: this.pauseReason } : {}),
      peakInputTokens: this.peakInputTokens,
      removedLines: this.removedLines,
      sessionId: this.sessionId,
      stageCount: this.stageCount,
      tasks: this.tasks,
      toolCalls,
      usageByModel: [...this.modelUsage].map(([model, usage]) => ({
        cachedInputTokens: usage.cachedInputTokens,
        inputTokens: usage.inputTokens,
        model,
        outputTokens: usage.outputTokens,
      })),
      wallDurationMs: Math.max(0, finishedAtMs - this.startedAtMs),
    };

    return this.summary;
  }

  public snapshot(nowMs = Date.now()): SessionMetricsSnapshot {
    const toolUsage = new Map(
      [...this.toolUsage].map(([name, usage]) => [name, { ...usage }] as const),
    );
    for (const activeTool of this.activeTools.values()) {
      const usage = toolUsage.get(activeTool.name) as MutableToolUsage;
      toolUsage.set(activeTool.name, {
        ...usage,
        durationMs: usage.durationMs + Math.max(0, nowMs - activeTool.startedAtMs),
      });
    }

    return {
      ...(this.compactAtContextRatio !== undefined
        ? { compactAtContextRatio: this.compactAtContextRatio }
        : {}),
      ...(this.contextComposition !== undefined
        ? { contextComposition: this.contextComposition }
        : {}),
      contextTokens: this.contextTokens,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      ...(this.contextWindowSource !== undefined
        ? { contextWindowSource: this.contextWindowSource }
        : {}),
      model: this.model,
      peakInputTokens: this.peakInputTokens,
      sessionId: this.sessionId,
      tasks: { ...this.tasks },
      toolCalls: [...toolUsage].map(([name, usage]) => ({ ...usage, name })),
      usageByModel: [...this.modelUsage].map(([model, usage]) => ({ ...usage, model })),
      wallDurationMs: Math.max(0, nowMs - this.startedAtMs),
    };
  }

  private applyUsage(model: string, usage: AgentUsage, direction: 1 | -1): void {
    const currentUsage = this.modelUsage.get(model) ?? {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    currentUsage.cachedInputTokens += usage.cachedInputTokens * direction;
    currentUsage.inputTokens += usage.inputTokens * direction;
    currentUsage.outputTokens += usage.outputTokens * direction;
    this.modelUsage.set(model, currentUsage);
  }

  public finishActiveTool(finishedAtMs: number, failed = false): void {
    for (const callId of [...this.activeTools.keys()]) {
      this.finishTool(callId, finishedAtMs, failed);
    }
  }

  private finishTool(callId: string, finishedAtMs: number, failed = false): void {
    const activeTool = this.activeTools.get(callId);

    if (!activeTool) {
      return;
    }
    const usage = this.getToolUsage(activeTool.name);
    usage.durationMs += Math.max(0, finishedAtMs - activeTool.startedAtMs);
    usage.errors += failed ? 1 : 0;
    this.activeTools.delete(callId);
  }

  private getToolUsage(name: string): MutableToolUsage {
    const usage = this.toolUsage.get(name) ?? {
      calls: 0,
      durationMs: 0,
      errors: 0,
    };

    this.toolUsage.set(name, usage);
    return usage;
  }

  private recordCodeChanges(input: unknown): void {
    const record = asRecord(input);
    const command = readString(record, "command");

    switch (command) {
      case "create":
        this.addedLines += countLines(readRawString(record, "file_text"));
        return;
      case "insert":
        this.addedLines += countLines(readRawString(record, "new_str"));
        return;
      case "str_replace":
        this.addedLines += countLines(readRawString(record, "new_str"));
        this.removedLines += countLines(readRawString(record, "old_str"));
        return;
      default:
        return;
    }
  }
}

export function formatTokenCount(value: number): string {
  const normalizedValue = Math.max(0, value);

  if (normalizedValue < 1_000) {
    return String(Math.round(normalizedValue));
  }

  if (normalizedValue < 1_000_000) {
    return `${formatDecimal(normalizedValue / 1_000)}K`;
  }

  return `${formatDecimal(normalizedValue / 1_000_000)}M`;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes > 0 ? `${minutes}m` : ""}${seconds > 0 ? `${seconds}s` : ""}`;
  }

  if (minutes > 0) {
    return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
  }

  return `${seconds}s`;
}

export function formatContextWindow(summary: SessionSummary): string {
  return formatContextUsage(summary.peakInputTokens, summary.contextWindow);
}

export function formatContextUsage(peakInputTokens: number, contextWindow?: number): string {
  const peak = formatTokenCount(peakInputTokens);

  if (contextWindow === undefined) {
    return `${peak} used (limit unknown)`;
  }

  const percentage = formatDecimal((peakInputTokens / contextWindow) * 100);

  return `${percentage}% used (${peak} / ${formatTokenCount(contextWindow)})`;
}

export function formatPromptContextUsage(contextTokens: number, contextWindow?: number): string {
  if (contextWindow === undefined || contextWindow <= 0) {
    return "unavailable";
  }
  const used = Math.max(0, contextTokens);
  const limit = Math.max(1, contextWindow);
  return `${formatTokenCount(used)}/${formatTokenCount(limit)} tokens (${formatDecimal(
    (used / limit) * 100,
  )}%)`;
}

export function calculateContextUsage(snapshot: SessionMetricsSnapshot): ContextUsageDetails {
  const usedTokens = Math.max(0, snapshot.contextTokens);
  const composition = snapshot.contextComposition;
  const rawCategories: readonly ContextUsageCategory[] = [
    {
      key: "system-prompt",
      label: "System prompt",
      tokens: composition?.systemPromptTokens ?? 0,
    },
    {
      key: "system-tools",
      label: "System tools",
      tokens: composition?.systemToolTokens ?? 0,
    },
    {
      key: "skills",
      label: "Skills",
      tokens: composition?.skillTokens ?? 0,
    },
    {
      key: "working-memory",
      label: "Working memory",
      tokens: composition?.workingMemoryTokens ?? 0,
    },
    {
      key: "semantic-memory",
      label: "Semantic memory",
      tokens: composition?.semanticMemoryTokens ?? 0,
    },
    {
      key: "procedure-memory",
      label: "Procedure memory",
      tokens: composition?.procedureMemoryTokens ?? 0,
    },
    {
      key: "scenario-memory",
      label: "Scenario memory",
      tokens: composition?.scenarioMemoryTokens ?? 0,
    },
  ];
  const staticTotal = rawCategories.reduce(
    (total, category) => total + Math.max(0, category.tokens),
    0,
  );
  const categories =
    staticTotal <= usedTokens
      ? [
          ...rawCategories,
          {
            key: "messages" as const,
            label: "Messages",
            tokens: usedTokens - staticTotal,
          },
        ]
      : scaleCategories(rawCategories, usedTokens);
  const contextWindow = snapshot.contextWindow;
  if (contextWindow === undefined || contextWindow <= 0) {
    return {
      autocompactBufferTokens: 0,
      categories,
      ...(snapshot.contextWindowSource !== undefined
        ? { contextWindowSource: snapshot.contextWindowSource }
        : {}),
      model: snapshot.model,
      usedTokens,
    };
  }
  const compactAt = snapshot.compactAtContextRatio ?? 0.92;
  const nominalBuffer = Math.round(contextWindow * Math.max(0, Math.min(1, 1 - compactAt)));
  const autocompactBufferTokens = Math.min(nominalBuffer, Math.max(0, contextWindow - usedTokens));

  return {
    autocompactBufferTokens,
    categories,
    contextWindow,
    ...(snapshot.contextWindowSource !== undefined
      ? { contextWindowSource: snapshot.contextWindowSource }
      : {}),
    freeTokens: Math.max(0, contextWindow - usedTokens - autocompactBufferTokens),
    model: snapshot.model,
    usedTokens,
  };
}

export function formatContextUsageDetails(contextTokens: number, contextWindow?: number): string {
  const used = Math.max(0, contextTokens);
  if (contextWindow === undefined || contextWindow <= 0) {
    return [`● Used: ${formatTokenCount(used)} tokens`, "○ Context limit unavailable"].join("\n");
  }

  const limit = Math.max(1, contextWindow);
  const ratio = Math.min(1, used / limit);
  const usedCells = Math.round(ratio * 100);
  const grid = Array.from({ length: 10 }, (_, row) =>
    Array.from({ length: 10 }, (_, column) => (row * 10 + column < usedCells ? "●" : "○")).join(
      " ",
    ),
  ).join("\n");
  const free = Math.max(0, limit - used);

  return [
    grid,
    "",
    `${formatTokenCount(used)} / ${formatTokenCount(limit)} tokens (${formatDecimal(ratio * 100)}% used)`,
    "",
    "Estimated usage",
    `● Used: ${formatTokenCount(used)} tokens`,
    `○ Free space: ${formatTokenCount(free)} tokens`,
  ].join("\n");
}

function scaleCategories(
  categories: readonly ContextUsageCategory[],
  usedTokens: number,
): readonly ContextUsageCategory[] {
  const total = categories.reduce((sum, category) => sum + Math.max(0, category.tokens), 0);
  if (total <= 0 || usedTokens <= 0) {
    return [
      ...categories.map((category) => ({ ...category, tokens: 0 })),
      {
        key: "messages",
        label: "Messages",
        tokens: usedTokens,
      },
    ];
  }
  const scaled = categories.map((category) => ({
    ...category,
    tokens: Math.floor((Math.max(0, category.tokens) / total) * usedTokens),
  }));
  const remainder = usedTokens - scaled.reduce((sum, category) => sum + category.tokens, 0);
  const first = scaled[0] as ContextUsageCategory;
  scaled[0] = {
    ...first,
    tokens: first.tokens + remainder,
  };
  return [
    ...scaled,
    {
      key: "messages",
      label: "Messages",
      tokens: 0,
    },
  ];
}

function getToolDisplayName(toolName: string, input: unknown, title: string): string {
  if (toolName === "textEditorTool") {
    const command = readString(asRecord(input), "command");

    if (command === "view") {
      return "Read";
    }

    if (command === "create") {
      return "Create";
    }

    return "Edit";
  }

  const names: Readonly<Record<string, string>> = {
    bashTool: "Bash",
    grepTool: "Grep",
    lsTool: "Ls",
    todoWriteTool: "Todo",
    treeTool: "Tree",
  };

  return names[toolName] ?? title;
}

function countLines(text: string | undefined): number {
  return text === undefined || text === "" ? 0 : text.split(/\r?\n/u).length;
}

function isToolError(output: unknown): boolean {
  return typeof output === "string" && output.trimStart().startsWith("Error:");
}

function formatDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRawString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];

  return typeof value === "string" ? value : undefined;
}
