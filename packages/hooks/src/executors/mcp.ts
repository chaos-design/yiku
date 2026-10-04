import { HookExecutionError, HookSecurityError } from "../errors.js";
import { HookLimits } from "../security/limits.js";
import type {
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookInvocation,
  HookMcpInvoker,
} from "../types.js";
import { runHookOperation, validateRunnerOutput } from "./model-result.js";

export interface McpHookExecutorOptions {
  readonly allowedTargets: readonly string[];
  readonly clock?: (() => Date) | undefined;
  readonly invoker: HookMcpInvoker;
  readonly limits?: HookLimits | undefined;
}

export class McpHookExecutor implements HookExecutor {
  public readonly type = "mcp";
  private readonly allowedTargets: ReadonlySet<string>;
  private readonly clock: () => Date;
  private readonly invoker: HookMcpInvoker;
  private readonly limits: HookLimits;

  public constructor(options: McpHookExecutorOptions) {
    this.allowedTargets = new Set(options.allowedTargets);
    this.clock = options.clock ?? (() => new Date());
    this.invoker = options.invoker;
    this.limits = options.limits ?? new HookLimits();
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "mcp") {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "MCP executor received a non-MCP handler.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const target = `${handler.server}/${handler.tool}`;
    if (!this.allowedTargets.has(target)) {
      throw new HookSecurityError("HOOK_SECURITY_REJECTED", "Hook MCP target is not allowlisted.", {
        executorType: this.type,
        hookId: invocation.hookId,
      });
    }

    if (context.depth >= this.limits.maxDepth) {
      throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook MCP recursion depth exceeded.", {
        executorType: this.type,
        hookId: invocation.hookId,
      });
    }

    const startedAt = this.clock();
    const output = await runHookOperation(invocation, context, (signal, timeoutMs) =>
      this.invoker.invoke({
        arguments: handler.arguments ?? {},
        event: invocation.event,
        server: handler.server,
        signal,
        timeoutMs,
        tool: handler.tool,
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
