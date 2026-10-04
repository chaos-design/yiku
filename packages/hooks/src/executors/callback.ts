import { parseHookHandlerOutput } from "../compatibility/output-schema.js";
import { HookError, HookExecutionError, HookTimeoutError } from "../errors.js";
import type {
  CallbackHookHandler,
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookInvocation,
} from "../types.js";

export interface CallbackHookExecutorOptions {
  readonly clock?: (() => Date) | undefined;
}

export class CallbackHookExecutor implements HookExecutor {
  public readonly type = "callback";
  private readonly clock: () => Date;

  public constructor(options: CallbackHookExecutorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "callback") {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "Callback executor received a non-callback handler.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const startedAt = this.clock();
    try {
      const output = await executeWithDeadline(handler, invocation, context, startedAt.getTime());
      const parsed = parseHookHandlerOutput(invocation.event.hook_event_name, output);
      const endedAt = this.clock();
      return {
        durationMs: endedAt.getTime() - startedAt.getTime(),
        endedAt: endedAt.toISOString(),
        output: parsed,
        startedAt: startedAt.toISOString(),
        status: "success",
      };
    } catch (error) {
      if (error instanceof HookError) {
        throw error;
      }

      throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Callback Hook execution failed.", {
        cause: error,
        eventName: invocation.event.hook_event_name,
        executorType: this.type,
        hookId: invocation.hookId,
      });
    }
  }
}

async function executeWithDeadline(
  handler: CallbackHookHandler,
  invocation: HookInvocation,
  context: HookExecutionContext,
  startedAt: number,
) {
  const remainingMs = context.deadline - startedAt;

  if (remainingMs <= 0) {
    throw timeoutError(invocation);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(timeoutError(invocation)), remainingMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortHandler = () =>
      reject(
        new HookExecutionError("HOOK_ABORTED", "Callback Hook was aborted.", {
          cause: context.signal?.reason,
          eventName: invocation.event.hook_event_name,
          executorType: "callback",
          hookId: invocation.hookId,
          retryable: true,
        }),
      );
    context.signal?.addEventListener("abort", abortHandler, { once: true });
    if (context.signal?.aborted === true) {
      abortHandler();
    }
  });

  try {
    return await Promise.race([
      handler.callback(invocation, context),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (abortHandler !== undefined) {
      context.signal?.removeEventListener("abort", abortHandler);
    }
  }
}

function timeoutError(invocation: HookInvocation): HookTimeoutError {
  return new HookTimeoutError("HOOK_TIMEOUT", "Callback Hook timed out.", {
    eventName: invocation.event.hook_event_name,
    executorType: "callback",
    hookId: invocation.hookId,
    retryable: true,
  });
}
