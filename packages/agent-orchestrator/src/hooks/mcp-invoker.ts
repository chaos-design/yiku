import {
  HookError,
  HookExecutionError,
  type HookHandlerOutput,
  HookLimits,
  type HookMcpInvokeInput,
  type HookMcpInvoker,
  type JsonObject,
} from "@yiku/hooks";
import { parseHookRunnerOutput } from "./model-runner.js";

export interface HookMcpRegistry {
  invoke(
    server: string,
    tool: string,
    arguments_: JsonObject,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<unknown>;
}

export interface RegistryHookMcpInvokerOptions {
  readonly limits?: HookLimits | undefined;
  readonly registry: HookMcpRegistry;
}

export class RegistryHookMcpInvoker implements HookMcpInvoker {
  private readonly limits: HookLimits;

  public constructor(private readonly options: RegistryHookMcpInvokerOptions) {
    this.limits = options.limits ?? new HookLimits();
  }

  public async invoke(input: HookMcpInvokeInput): Promise<HookHandlerOutput> {
    try {
      const output = await this.options.registry.invoke(input.server, input.tool, input.arguments, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        timeoutMs: input.timeoutMs,
      });

      return parseHookRunnerOutput(
        {
          event: input.event,
          maxOutputBytes: this.limits.maxOutputBytes,
        },
        output,
      );
    } catch (error) {
      if (error instanceof HookError) {
        throw error;
      }

      throw new HookExecutionError("HOOK_EXECUTION_FAILED", "Hook MCP invocation failed.", {
        cause: error,
        eventName: input.event.hook_event_name,
        executorType: "mcp",
        retryable: true,
      });
    }
  }
}
