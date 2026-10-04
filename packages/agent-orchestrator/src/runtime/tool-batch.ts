import type { HookDecision, HookEventBase, HookSession, PostToolBatchResult } from "@yiku/hooks";

export interface ToolBatchContext {
  readonly eventBase: HookEventBase<"PostToolBatch">;
  readonly hookSession: HookSession;
}

interface PendingToolResult extends PostToolBatchResult {
  readonly order: number;
}

export class ToolBatchTracker {
  private nextOrder = 0;
  private readonly orderByCallId = new Map<string, number>();
  private readonly results = new Map<string, PendingToolResult>();

  public begin(toolUseId: string): void {
    if (this.orderByCallId.has(toolUseId)) {
      return;
    }

    this.nextOrder += 1;
    this.orderByCallId.set(toolUseId, this.nextOrder);
  }

  public finish(toolUseId: string, toolName: string, status: PostToolBatchResult["status"]): void {
    this.begin(toolUseId);
    this.results.set(toolUseId, {
      order: this.orderByCallId.get(toolUseId) ?? this.nextOrder,
      status,
      tool_name: toolName,
      tool_use_id: toolUseId,
    });
  }

  public hasPending(): boolean {
    return this.results.size > 0;
  }

  public async flush(context: ToolBatchContext): Promise<HookDecision | undefined> {
    if (this.results.size === 0) {
      return undefined;
    }

    const results = [...this.results.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ order: _order, ...result }) => result);
    const decision = await context.hookSession.dispatch({
      ...context.eventBase,
      hook_event_name: "PostToolBatch",
      results,
    });

    for (const result of results) {
      this.results.delete(result.tool_use_id);
      this.orderByCallId.delete(result.tool_use_id);
    }

    return decision;
  }
}
