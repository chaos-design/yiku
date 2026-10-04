import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { defaultSpawn, hasErrorCode } from "./process.js";

const MAX_OUTPUT_BYTES = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type ShellSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ShellCommandServiceOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly shell?: readonly [string, ...string[]] | undefined;
  readonly spawn?: ShellSpawn | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ShellCommandRunOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ShellCommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export class ShellCommandService {
  private readonly cwd?: string | undefined;
  private readonly env?: NodeJS.ProcessEnv | undefined;
  private readonly shell: readonly [string, ...string[]];
  private readonly spawn: ShellSpawn;
  private readonly timeoutMs: number;

  public constructor(options: ShellCommandServiceOptions = {}) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.shell = options.shell ?? defaultShell(options.platform ?? process.platform);
    this.spawn = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public run(command: string, options: ShellCommandRunOptions = {}): Promise<ShellCommandResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      return Promise.reject(new Error("Shell command must not be empty."));
    }

    return new Promise((resolve, reject) => {
      const [file, ...shellArgs] = this.shell;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawn(file, [...shellArgs, trimmed], {
          ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
          ...(this.env !== undefined ? { env: this.env } : {}),
          stdio: "pipe",
        });
      } catch (error) {
        reject(startError(file, error));
        return;
      }

      const signal = options.signal;
      const stdout = new BoundedBuffer();
      const stderr = new BoundedBuffer();
      let settled = false;
      let timedOut = false;

      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, this.timeoutMs)
          : undefined;

      const onAbort = () => {
        child.kill("SIGKILL");
      };

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
        child.off("close", onClose);
        child.off("error", onError);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
      };
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onStdout = (chunk: Buffer | string) => stdout.append(chunk);
      const onStderr = (chunk: Buffer | string) => stderr.append(chunk);
      const onError = (error: Error) => {
        finish(() => reject(startError(file, error)));
      };
      const onClose = (code: number | null) => {
        finish(() =>
          resolve({
            exitCode: code,
            stderr: stderr.toString(),
            stdout: stdout.toString(),
            timedOut,
            truncated: stdout.truncated || stderr.truncated,
          }),
        );
      };

      if (signal?.aborted) {
        onAbort();
      }
      signal?.addEventListener("abort", onAbort);
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      child.stdin.end();
    });
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  public append(chunk: Buffer | string): void {
    if (this.bytes >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_OUTPUT_BYTES - this.bytes;
    if (buffer.length > remaining) {
      this.chunks.push(buffer.subarray(0, remaining));
      this.bytes = MAX_OUTPUT_BYTES;
      this.truncated = true;
      return;
    }
    this.chunks.push(buffer);
    this.bytes += buffer.length;
  }

  public toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function defaultShell(platform: NodeJS.Platform): readonly [string, ...string[]] {
  if (platform === "win32") {
    return [process.env.ComSpec?.trim() || "cmd.exe", "/d", "/s", "/c"];
  }
  return [process.env.SHELL?.trim() || "/bin/sh", "-c"];
}

function startError(command: string, error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(`Unable to start shell command ${command}: ${cause.message}`, {
    cause,
  });
  if (hasErrorCode(cause, "ENOENT")) {
    Object.assign(wrapped, { code: "ENOENT" });
  }
  return wrapped;
}
