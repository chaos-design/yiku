import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { defaultSpawn, hasErrorCode } from "./process.js";

const MAX_STDERR_BYTES = 4_096;

export type ClipboardSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ClipboardServiceOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly spawn?: ClipboardSpawn | undefined;
}

interface ClipboardCommand {
  readonly args: readonly string[];
  readonly file: string;
}

export class ClipboardService {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: ClipboardSpawn;

  public constructor(options: ClipboardServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  public async write(text: string): Promise<void> {
    if (this.platform === "linux") {
      try {
        await this.run({ args: [], file: "wl-copy" }, text);
        return;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }

      await this.run({ args: ["-selection", "clipboard"], file: "xclip" }, text);
      return;
    }

    const command = platformCommand(this.platform);
    if (command === undefined) {
      throw new Error(`Clipboard is not supported on platform ${this.platform}.`);
    }
    await this.run(command, text);
  }

  private run(command: ClipboardCommand, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawn(command.file, command.args, { stdio: "pipe" });
      } catch (error) {
        reject(startError(command.file, error));
        return;
      }

      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      let settled = false;

      const cleanup = () => {
        child.off("close", onClose);
        child.off("error", onProcessError);
        child.stdin.off("error", onStdinError);
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
      const onStderr = (chunk: Buffer | string) => {
        if (stderrBytes >= MAX_STDERR_BYTES) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        const bounded = buffer.subarray(0, remaining);
        stderrChunks.push(bounded);
        stderrBytes += bounded.length;
      };
      const onProcessError = (error: Error) => {
        finish(() => reject(startError(command.file, error)));
      };
      const onStdinError = (error: Error) => {
        finish(() =>
          reject(
            new Error(`Unable to write to clipboard command ${command.file}: ${error.message}`, {
              cause: error,
            }),
          ),
        );
      };
      const onClose = (code: number | null) => {
        finish(() => {
          if (code === 0) {
            resolve();
            return;
          }
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `Clipboard command ${command.file} exited with code ${code ?? "unknown"}${
                stderr ? `: ${stderr}` : "."
              }`,
            ),
          );
        });
      };

      child.stderr.on("data", onStderr);
      child.stdin.once("error", onStdinError);
      child.once("error", onProcessError);
      child.once("close", onClose);
      child.stdin.end(text);
    });
  }
}

function platformCommand(platform: NodeJS.Platform): ClipboardCommand | undefined {
  switch (platform) {
    case "darwin":
      return { args: [], file: "pbcopy" };
    case "win32":
      return { args: [], file: "clip" };
    default:
      return undefined;
  }
}

function startError(command: string, error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(`Unable to start clipboard command ${command}: ${cause.message}`, {
    cause,
  });
  if (hasErrorCode(cause, "ENOENT")) {
    Object.assign(wrapped, { code: "ENOENT" });
  }
  return wrapped;
}
