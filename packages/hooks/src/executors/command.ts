import { type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { HookExecutionError, HookTimeoutError } from "../errors.js";
import { HookLimits } from "../security/limits.js";
import type {
  CommandHookHandler,
  HookExecutionContext,
  HookExecutionResult,
  HookExecutor,
  HookHandler,
  HookInvocation,
} from "../types.js";
import { parseCommandHookResult } from "./command-result.js";
import { terminateProcessTree } from "./process-tree.js";

export interface CommandHookExecutorOptions {
  readonly clock?: (() => Date) | undefined;
  readonly limits?: HookLimits | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export class CommandHookExecutor implements HookExecutor {
  public readonly type = "command";
  private readonly clock: () => Date;
  private readonly limits: HookLimits;
  private readonly platform: NodeJS.Platform;

  public constructor(options: CommandHookExecutorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.limits = options.limits ?? new HookLimits();
    this.platform = options.platform ?? process.platform;
  }

  public async execute(
    invocation: HookInvocation,
    handler: HookHandler,
    context: HookExecutionContext,
  ): Promise<HookExecutionResult> {
    if (handler.type !== "command") {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        "Command executor received a non-command handler.",
        {
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const input = `${JSON.stringify(invocation.event)}\n`;
    const inputBytes = Buffer.byteLength(input);
    if (inputBytes > this.limits.maxInputBytes) {
      throw new HookExecutionError(
        "HOOK_EXECUTION_FAILED",
        `Command Hook input exceeds ${this.limits.maxInputBytes} bytes.`,
        {
          eventName: invocation.event.hook_event_name,
          executorType: this.type,
          hookId: invocation.hookId,
        },
      );
    }

    const startedAt = this.clock();
    const remainingMs = context.deadline - startedAt.getTime();
    if (remainingMs <= 0) {
      throw timeoutError(invocation);
    }

    const output = await this.runProcess(invocation, handler, context, input, remainingMs);
    const endedAt = this.clock();
    const normalized = parseCommandHookResult({
      eventName: invocation.event.hook_event_name,
      exitCode: output.exitCode,
      stderr: output.stderr.text,
      stdout: output.stdout.text,
    });

    return {
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt: endedAt.toISOString(),
      ...(normalized.errorCode !== undefined ? { errorCode: normalized.errorCode } : {}),
      exitCode: output.exitCode,
      ...(normalized.output !== undefined ? { output: normalized.output } : {}),
      startedAt: startedAt.toISOString(),
      status: normalized.status,
      stderr: output.stderr.text,
      stdout: output.stdout.text,
      ...(output.stderr.truncatedBytes > 0
        ? { truncatedStderrBytes: output.stderr.truncatedBytes }
        : {}),
      ...(output.stdout.truncatedBytes > 0
        ? { truncatedStdoutBytes: output.stdout.truncatedBytes }
        : {}),
    };
  }

  private runProcess(
    invocation: HookInvocation,
    handler: CommandHookHandler,
    context: HookExecutionContext,
    input: string,
    remainingMs: number,
  ): Promise<CommandProcessResult> {
    const command = resolveCommand(handler, this.platform);
    const child = spawn(command.file, command.args, {
      cwd: invocation.event.cwd,
      detached: this.platform !== "win32",
      env: {
        ...process.env,
        ...context.environment,
        CLAUDE_PROJECT_DIR: invocation.event.cwd,
        CLAUDE_SESSION_ID: invocation.event.session_id,
      },
      stdio: "pipe",
      windowsHide: true,
    } satisfies SpawnOptionsWithoutStdio);
    const stdout = new BoundedOutput(this.limits.maxOutputBytes);
    const stderr = new BoundedOutput(this.limits.maxOutputBytes);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", onAbort);
        child.stdin.off("error", onError);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onStdout = (chunk: Buffer) => stdout.append(chunk);
      const onStderr = (chunk: Buffer) => stderr.append(chunk);
      const onError = (error: Error) => {
        finish(() =>
          reject(
            new HookExecutionError("HOOK_EXECUTION_FAILED", "Unable to start Command Hook.", {
              cause: error,
              eventName: invocation.event.hook_event_name,
              executorType: this.type,
              hookId: invocation.hookId,
            }),
          ),
        );
      };
      const onClose = (exitCode: number | null) => {
        finish(() => {
          if (exitCode === null) {
            reject(
              new HookExecutionError(
                "HOOK_EXECUTION_FAILED",
                "Command Hook closed without an exit code.",
                {
                  eventName: invocation.event.hook_event_name,
                  executorType: this.type,
                  hookId: invocation.hookId,
                },
              ),
            );
            return;
          }
          resolve({
            exitCode,
            stderr: stderr.result(),
            stdout: stdout.result(),
          });
        });
      };
      const onAbort = () => {
        finish(() => {
          terminateProcessTree(child, { platform: this.platform });
          reject(
            new HookExecutionError("HOOK_ABORTED", "Command Hook was aborted.", {
              cause: context.signal?.reason,
              eventName: invocation.event.hook_event_name,
              executorType: this.type,
              hookId: invocation.hookId,
              retryable: true,
            }),
          );
        });
      };
      const timeout = setTimeout(() => {
        finish(() => {
          terminateProcessTree(child, { platform: this.platform });
          reject(timeoutError(invocation));
        });
      }, remainingMs);

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.stdin.on("error", onError);
      child.once("error", onError);
      child.once("close", onClose);
      context.signal?.addEventListener("abort", onAbort, { once: true });

      if (context.signal?.aborted === true) {
        onAbort();
        return;
      }

      child.stdin.end(input);
    });
  }
}

interface CommandProcessResult {
  readonly exitCode: number;
  readonly stderr: BoundedOutputResult;
  readonly stdout: BoundedOutputResult;
}

interface BoundedOutputResult {
  readonly text: string;
  readonly truncatedBytes: number;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  private totalBytes = 0;

  public constructor(private readonly maxBytes: number) {}

  public append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const remaining = this.maxBytes - this.keptBytes;

    if (remaining <= 0) {
      return;
    }

    const kept = chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.keptBytes += kept.length;
  }

  public result(): BoundedOutputResult {
    return {
      text: Buffer.concat(this.chunks).toString("utf8"),
      truncatedBytes: Math.max(0, this.totalBytes - this.keptBytes),
    };
  }
}

function resolveCommand(
  handler: CommandHookHandler,
  platform: NodeJS.Platform,
): { readonly args: readonly string[]; readonly file: string } {
  if (handler.args !== undefined) {
    return {
      args: handler.args,
      file: handler.command,
    };
  }

  if (platform === "win32") {
    return {
      args: ["-NoProfile", "-NonInteractive", "-Command", handler.command],
      file: handler.shell ?? "powershell.exe",
    };
  }

  return {
    args: ["-lc", handler.command],
    file: handler.shell ?? "/bin/sh",
  };
}

function timeoutError(invocation: HookInvocation): HookTimeoutError {
  return new HookTimeoutError("HOOK_TIMEOUT", "Command Hook timed out.", {
    eventName: invocation.event.hook_event_name,
    executorType: "command",
    hookId: invocation.hookId,
    retryable: true,
  });
}
