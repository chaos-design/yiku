import { HookExecutionError } from "../errors.js";
import { HookLimits } from "../security/limits.js";
import type {
  HookAgentRunner,
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookInvocation,
} from "../types.js";
import { renderHookPrompt, runHookOperation, validateRunnerOutput } from "./model-result.js";

export interface AgentHookExecutorOptions {
  readonly clock?: (() => Date) | undefined;
  readonly limits?: HookLimits | undefined;
  readonly runner: HookAgentRunner;
}

export class AgentHookExecutor implements HookExecutor {
  public readonly type = "agent";
  private readonly clock: () => Date;
  private readonly limits: HookLimits;
  private readonly runner: HookAgentRunner;

  public constructor(options: AgentHookExecutorOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.limits = options.limits ?? new HookLimits();
    this.runner = options.runner;
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "agent") {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "Agent executor received a non-agent handler.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    if (context.depth >= this.limits.maxDepth) {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "Hook Agent recursion depth exceeded.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const startedAt = this.clock();
    const prompt = renderHookPrompt(handler.prompt, invocation.event);
    const output = await runHookOperation(invocation, context, (signal, timeoutMs) =>
      this.runner.run({
        event: invocation.event,
        maxOutputBytes: this.limits.maxOutputBytes,
        maxTokens: this.limits.maxAgentTokens,
        maxToolCalls: this.limits.maxAgentToolCalls,
        maxTurns: handler.maxTurns ?? 50,
        ...(handler.model !== undefined ? { model: handler.model } : {}),
        prompt,
        signal,
        timeoutMs,
      }),
    );
    const validated = validateRunnerOutput(invocation, output, this.limits.maxOutputBytes);
    const endedAt = this.clock();

    return {
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt: endedAt.toISOString(),
      output: validated,
      startedAt: startedAt.toISOString(),
      status: "success",
    };
  }
}
