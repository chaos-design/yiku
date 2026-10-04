import { HookExecutionError } from "../errors.js";
import { HookLimits } from "../security/limits.js";
import type {
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookInvocation,
  HookModelRunner,
} from "../types.js";
import { renderHookPrompt, runHookOperation, validateRunnerOutput } from "./model-result.js";

export interface PromptHookExecutorOptions {
  readonly clock?: (() => Date) | undefined;
  readonly limits?: HookLimits | undefined;
  readonly runner: HookModelRunner;
}

export class PromptHookExecutor implements HookExecutor {
  public readonly type = "prompt";
  private readonly clock: () => Date;
  private readonly limits: HookLimits;
  private readonly runner: HookModelRunner;

  public constructor(options: PromptHookExecutorOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.limits = options.limits ?? new HookLimits();
    this.runner = options.runner;
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "prompt") {
      throw wrongHandler(invocation);
    }

    const startedAt = this.clock();
    const prompt = renderHookPrompt(handler.prompt, invocation.event);
    const output = await runHookOperation(invocation, context, (signal, timeoutMs) =>
      this.runner.run({
        event: invocation.event,
        maxOutputBytes: this.limits.maxOutputBytes,
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

function wrongHandler(invocation: HookInvocation): HookExecutionError {
  return new HookExecutionError(
    "HOOK_EXECUTION_FAILED",
    "Prompt executor received a non-prompt handler.",
    {
      executorType: "prompt",
      hookId: invocation.hookId,
    },
  );
}
