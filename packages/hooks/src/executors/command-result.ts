import { getHookEventCapability } from "../compatibility/manifest.js";
import { parseHookHandlerOutput } from "../compatibility/output-schema.js";
import { HookProtocolError } from "../errors.js";
import type { HookEventName, HookExecutionStatus, HookHandlerOutput } from "../types.js";

export interface CommandResultInput {
  readonly eventName: HookEventName;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface NormalizedCommandResult {
  readonly errorCode?: string | undefined;
  readonly output?: HookHandlerOutput | undefined;
  readonly status: HookExecutionStatus;
}

export function parseCommandHookResult(input: CommandResultInput): NormalizedCommandResult {
  const stdout = input.stdout.trim();
  const stderr = input.stderr.trim();

  if (input.exitCode === 0) {
    if (!stdout) {
      return { status: "success" };
    }

    if (looksLikeJson(stdout)) {
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch (error) {
        throw new HookProtocolError(
          "HOOK_PROTOCOL_INVALID",
          "Command Hook returned invalid JSON.",
          {
            cause: error,
            eventName: input.eventName,
            executorType: "command",
          },
        );
      }

      return {
        output: parseHookHandlerOutput(input.eventName, value),
        status: "success",
      };
    }

    return {
      output: plainOutput(input.eventName, stdout),
      status: "success",
    };
  }

  if (input.exitCode === 2) {
    const capability = getHookEventCapability(input.eventName);
    const reason = stderr || stdout || "Command Hook blocked the operation.";

    switch (capability.exitCodeTwo) {
      case "block":
        return {
          output: {
            action: "block",
            reason,
          },
          status: "success",
        };
      case "feedback":
        return {
          output: plainOutput(input.eventName, reason),
          status: "success",
        };
      case "ignore":
        return {
          status: "success",
        };
    }
  }

  return {
    errorCode: "HOOK_EXECUTION_FAILED",
    ...(stderr || stdout
      ? {
          output: {
            systemMessage: stderr || stdout,
          },
        }
      : {}),
    status: "error",
  };
}

function plainOutput(eventName: HookEventName, value: string): HookHandlerOutput {
  const capability = getHookEventCapability(eventName);

  return capability.decisions.includes("context")
    ? { additionalContext: value }
    : { systemMessage: value };
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}
