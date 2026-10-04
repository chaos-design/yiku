import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { EvaluationError, sha256Digest, type VerificationCommand } from "@yiku/evals";
import { PlatformShellSandbox, type ShellProcessSandbox } from "@yiku/sandbox";
import type { VerificationCommandResult, VerificationCommandRunnerOptions } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const SECRET_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,})/gu;

export class VerificationCommandRunner {
  private readonly options: VerificationCommandRunnerOptions;
  private readonly ownsSandbox: boolean;
  private readonly sandbox: ShellProcessSandbox;

  public constructor(options: VerificationCommandRunnerOptions) {
    this.options = options;
    this.ownsSandbox = options.sandbox === undefined;
    this.sandbox =
      options.sandbox ??
      new PlatformShellSandbox({
        network: "deny",
        ...(options.runtimeReadPaths !== undefined
          ? { runtimeReadPaths: options.runtimeReadPaths }
          : {}),
      });
    if (
      !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes <= 0 ||
      this.maxOutputBytes > MAX_OUTPUT_BYTES
    ) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        `Verification output limit must be between 1 and ${MAX_OUTPUT_BYTES} bytes.`,
      );
    }
  }

  public close(): void {
    if (this.ownsSandbox) {
      this.sandbox.close();
    }
  }

  public async run(
    command: VerificationCommand,
    signal?: AbortSignal,
  ): Promise<VerificationCommandResult> {
    validateCommand(command);
    if (signal?.aborted) {
      throw aborted(signal);
    }
    const workspace = this.options.workspace;
    if (command.writePolicy === "isolated" && this.options.isolatedWorkspace !== true) {
      throw new EvaluationError(
        "EVAL_PLAN_UNSATISFIABLE",
        `Verification command ${command.id} requires an isolated workspace.`,
      );
    }
    const cwd = workspace.assertPath(resolve(workspace.rootDir, command.cwd));
    const environment = allowlistedEnvironment(workspace.environment, command.envAllowlist);
    const executable = await resolveExecutable(command.command, environment.PATH);
    const sandbox = this.sandbox;
    if (sandbox.isolation === "host-policy") {
      throw new EvaluationError(
        "EVAL_PLAN_UNSATISFIABLE",
        "Verification commands require an enforceable sandbox boundary.",
      );
    }
    if (command.network === "deny" && sandbox.network !== "deny") {
      throw new EvaluationError(
        "EVAL_PLAN_UNSATISFIABLE",
        "Verification command requires denied network access.",
      );
    }
    if (command.network === "allowlist") {
      throw new EvaluationError(
        "EVAL_PLAN_UNSATISFIABLE",
        "Verification network allowlists are unavailable in the current sandbox.",
      );
    }
    const launch = sandbox.createLaunchSpec({
      cwd,
      environment,
      shellPath: executable,
      workspace,
      workspaceAccess: command.writePolicy === "read-only" ? "read-only" : "read-write",
    });
    const stdout = new BoundedOutput(this.maxOutputBytes);
    const stderr = new BoundedOutput(this.maxOutputBytes);
    const startedAt = performance.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(launch.command, [...launch.args, ...command.args], {
        cwd: launch.cwd,
        detached: true,
        env: { ...launch.environment },
        stdio: "pipe",
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new EvaluationError(
        "EVAL_PROVIDER_UNAVAILABLE",
        `Verification command ${command.id} could not start.`,
        { cause: error },
      );
    }

    let timedOut = false;
    const completion = await new Promise<{
      readonly exitCode?: number | undefined;
      readonly signal?: NodeJS.Signals | undefined;
    }>((resolveCompletion, reject) => {
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate(child, "SIGTERM");
        forceKill = setTimeout(() => terminate(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
        forceKill.unref();
      }, command.timeoutMs);
      const finish = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forceKill !== undefined) {
          clearTimeout(forceKill);
        }
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        operation();
      };
      const onStdout = (chunk: Buffer) => stdout.update(chunk);
      const onStderr = (chunk: Buffer) => stderr.update(chunk);
      const onError = (error: Error) => {
        finish(() =>
          reject(
            new EvaluationError(
              "EVAL_PROVIDER_UNAVAILABLE",
              `Verification command ${command.id} could not start.`,
              { cause: error },
            ),
          ),
        );
      };
      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
        finish(() =>
          resolveCompletion({
            ...(code !== null ? { exitCode: code } : {}),
            ...(closeSignal !== null ? { signal: closeSignal } : {}),
          }),
        );
      };
      const onAbort = () => {
        terminate(child, "SIGTERM");
        const kill = setTimeout(() => terminate(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
        kill.unref();
        finish(() => reject(aborted(signal)));
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
    const durationMs = Math.max(0, performance.now() - startedAt);
    const outputDigest = sha256Digest({
      stderr: stderr.digest(),
      stdout: stdout.digest(),
    });
    const artifactSemantic = {
      args: command.args.join("\0"),
      command: executable,
      cwd,
      durationMs: Math.round(durationMs),
      exitCode: completion.exitCode ?? -1,
      network: command.network,
      outputDigest,
      sandbox: sandbox.isolation,
      signal: completion.signal ?? "",
      timedOut,
      writePolicy: command.writePolicy,
    };
    const artifact = Object.freeze({
      digest: sha256Digest(artifactSemantic),
      id: `command-${sha256Digest({ id: command.id, outputDigest })}`,
      kind: "command-result" as const,
      metadata: Object.freeze(artifactSemantic),
      sizeBytes: stdout.totalBytes + stderr.totalBytes,
      storageRef: `command:${command.id}:${outputDigest}`,
    });
    return Object.freeze({
      artifact,
      command: Object.freeze({
        ...command,
        args: Object.freeze([...command.args]),
        envAllowlist: Object.freeze([...command.envAllowlist]),
      }),
      durationMs,
      ...(completion.exitCode !== undefined ? { exitCode: completion.exitCode } : {}),
      outputDigest,
      ...(completion.signal !== undefined ? { signal: completion.signal } : {}),
      stderrHead: redact(stderr.headText()),
      stderrTail: redact(stderr.tailText()),
      stdoutHead: redact(stdout.headText()),
      stdoutTail: redact(stdout.tailText()),
      timedOut,
    });
  }

  private get maxOutputBytes(): number {
    return this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  private get spawn(): typeof spawn {
    return this.options.spawnProcess ?? spawn;
  }
}

class BoundedOutput {
  private readonly hash = createHash("sha256");
  private head = Buffer.alloc(0);
  private readonly limit: number;
  private tail = Buffer.alloc(0);
  public totalBytes = 0;

  public constructor(limit: number) {
    this.limit = limit;
  }

  public update(chunk: Buffer): void {
    this.hash.update(chunk);
    this.totalBytes += chunk.byteLength;
    if (this.head.byteLength < this.limit) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.limit - this.head.byteLength)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.limit);
  }

  public digest(): string {
    return this.hash.copy().digest("hex");
  }

  public headText(): string {
    return this.head.toString("utf8");
  }

  public tailText(): string {
    return this.tail.toString("utf8");
  }
}

function validateCommand(command: VerificationCommand): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(command.id)) {
    throw new EvaluationError("EVAL_PROFILE_INVALID", "Verification command ID is invalid.");
  }
  if (
    !command.command.trim() ||
    command.command.includes("\0") ||
    command.args.some((argument) => argument.includes("\0"))
  ) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Verification command ${command.id} contains invalid command data.`,
    );
  }
  if (
    isAbsolute(command.cwd) ||
    command.cwd
      .replaceAll("\\", "/")
      .split("/")
      .some((segment) => segment === "..")
  ) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Verification command ${command.id} cwd must stay relative to the workspace.`,
    );
  }
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 3_600_000
  ) {
    throw new EvaluationError(
      "EVAL_PROFILE_INVALID",
      `Verification command ${command.id} timeout is invalid.`,
    );
  }
  const names = new Set<string>();
  for (const name of command.envAllowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || names.has(name)) {
      throw new EvaluationError(
        "EVAL_PROFILE_INVALID",
        `Verification command ${command.id} environment allowlist is invalid.`,
      );
    }
    names.add(name);
  }
}

function allowlistedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    if (source[name] !== undefined) {
      result[name] = source[name];
    }
  }
  return result;
}

async function resolveExecutable(command: string, pathValue: string | undefined): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (pathValue ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new EvaluationError(
    "EVAL_PROVIDER_UNAVAILABLE",
    `Verification executable is unavailable: ${command}.`,
  );
}

function terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  child.kill(signal);
}

function aborted(signal: AbortSignal | undefined): EvaluationError {
  return new EvaluationError("EVAL_ABORTED", "Verification command was aborted.", {
    cause: signal?.reason,
  });
}

function redact(value: string): string {
  return value.replaceAll(SECRET_PATTERN, "[REDACTED]");
}
