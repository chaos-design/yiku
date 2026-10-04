import { parseHookHandlerOutput } from "../compatibility/output-schema.js";
import { HookError, HookExecutionError, HookTimeoutError } from "../errors.js";
import type {
  HookEvent,
  HookExecutionContext,
  HookHandlerOutput,
  HookInvocation,
} from "../types.js";

export function renderHookPrompt(template: string, event: HookEvent): string {
  return template.replaceAll("$ARGUMENTS", JSON.stringify(event));
}

export function validateRunnerOutput(
  invocation: HookInvocation,
  output: HookHandlerOutput,
  maxOutputBytes: number,
): HookHandlerOutput {
  const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");

  if (outputBytes > maxOutputBytes) {
    throw new HookExecutionError(
      "HOOK_EXECUTION_FAILED",
      `Hook model output exceeds ${maxOutputBytes} bytes.`,
      {
        eventName: invocation.event.hook_event_name,
        executorType: invocation.handler.type,
        hookId: invocation.hookId,
      },
    );
  }

  return parseHookHandlerOutput(invocation.event.hook_event_name, output);
}

export async function runHookOperation<T>(
  invocation: HookInvocation,
  context: HookExecutionContext,
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = context.deadline - Date.now();
  if (timeoutMs <= 0) {
    throw timeoutError(invocation);
  }

  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(
      context.signal?.reason instanceof HookError
        ? context.signal.reason
        : new HookExecutionError("HOOK_ABORTED", "Hook runner was aborted.", {
            cause: context.signal?.reason,
            eventName: invocation.event.hook_event_name,
            executorType: invocation.handler.type,
            hookId: invocation.hookId,
            retryable: true,
          }),
    );
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (context.signal?.aborted === true) {
    abortFromParent();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = timeoutError(invocation);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) {
      rejectAbort();
    }
  });

  try {
    return await Promise.race([
      operation(controller.signal, timeoutMs),
      timeoutPromise,
      abortPromise,
    ]);
  } catch (error) {
    if (error instanceof HookError) {
      throw error;
    }

    throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook runner execution failed.", {
      cause: error,
      eventName: invocation.event.hook_event_name,
      executorType: invocation.handler.type,
      hookId: invocation.hookId,
    });
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    context.signal?.removeEventListener("abort", abortFromParent);
  }
}

function timeoutError(invocation: HookInvocation): HookTimeoutError {
  return new HookTimeoutError("HOOK_TIMEOUT", "Hook runner timed out.", {
    eventName: invocation.event.hook_event_name,
    executorType: invocation.handler.type,
    hookId: invocation.hookId,
    retryable: true,
  });
}
