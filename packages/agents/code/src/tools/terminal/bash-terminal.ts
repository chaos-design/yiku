import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  HostPolicyShellSandbox,
  PlatformShellSandbox,
  type ShellProcessSandbox,
} from "@yiku/sandbox";
import { requestPermissionApproval, ShellPolicy } from "../../permission/index.js";
import { truncateText } from "../common/output.js";
import { terminateProcessGroup } from "../common/process.js";
import { requireNonEmpty } from "../common/validation.js";
import { WorkspaceContext } from "../common/workspace-context.js";
import {
  BASH_TERMINAL_TOOL_DEFINITION,
  type BashTerminalOptions,
  type BashToolExecutionOptions,
  type BashToolExecutor,
  type BashToolInput,
  DEFAULT_BASH_MAX_OUTPUT_CHARACTERS,
  DEFAULT_BASH_STARTUP_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_MS,
} from "./types.js";

const MAX_STARTUP_STDERR_CHARACTERS = 4_000;

export class BashTerminal implements BashToolExecutor {
  private activeSandbox: ShellProcessSandbox;
  private bashProcess: ChildProcessWithoutNullStreams | undefined;
  private boundaryReported = false;
  private currentCwd: string;
  private readonly fallbackSandbox: ShellProcessSandbox;
  private lifecycleVersion = 0;
  private readonly options: BashTerminalOptions;
  private readonly preferredSandbox: ShellProcessSandbox;
  private queue: Promise<unknown> = Promise.resolve();
  private shellPolicy: ShellPolicy;
  private readonly workspace: WorkspaceContext;

  public constructor(options: BashTerminalOptions = {}) {
    this.options = options;
    this.workspace =
      options.workspace ??
      new WorkspaceContext({
        environment: options.env ?? process.env,
        rootDir: options.cwd ?? process.cwd(),
      });
    if (options.workspace !== undefined && options.cwd !== undefined) {
      const cwd = options.workspace.assertPath(options.cwd);
      if (cwd !== options.workspace.rootDir) {
        throw new Error("Bash cwd must match the Workspace Context root.");
      }
    }
    if (options.workspace !== undefined && options.env !== undefined) {
      throw new Error("Bash environment must be configured through the Workspace Context.");
    }
    this.currentCwd = this.workspace.rootDir;
    this.preferredSandbox = options.shellSandbox ?? new PlatformShellSandbox();
    this.fallbackSandbox = options.fallbackSandbox ?? new HostPolicyShellSandbox();
    this.activeSandbox = this.preferredSandbox;
    this.shellPolicy =
      options.shellPolicy ??
      new ShellPolicy({
        isolation: this.preferredSandbox.isolation,
        network: this.preferredSandbox.network,
      });
    if (
      this.shellPolicy.isolation !== this.preferredSandbox.isolation ||
      this.shellPolicy.network !== this.preferredSandbox.network
    ) {
      throw new Error("Shell Policy must match the configured Shell Sandbox boundary.");
    }
  }

  public execute(
    input: BashToolInput,
    executionOptions: BashToolExecutionOptions = {},
  ): Promise<string> {
    return this.enqueue(() => this.executeNow(input, executionOptions));
  }

  public reset(): Promise<void> {
    return this.enqueue(() => {
      this.lifecycleVersion += 1;
      this.stopProcess();
      this.currentCwd = this.workspace.rootDir;
    });
  }

  public close(): void {
    this.lifecycleVersion += 1;
    this.stopProcess();
    this.preferredSandbox.close();
    if (this.fallbackSandbox !== this.preferredSandbox) {
      this.fallbackSandbox.close();
    }
  }

  private async executeNow(
    input: BashToolInput,
    executionOptions: BashToolExecutionOptions,
  ): Promise<string> {
    const command = requireNonEmpty(input.command, "Bash command is required.");
    const validationError = this.options.validateCommand?.(command);

    if (validationError) {
      throw new Error(validationError);
    }
    const workspaceValidationError = validateWorkspaceCommand(
      command,
      this.currentCwd,
      this.workspace,
    );
    if (workspaceValidationError !== undefined) {
      throw new Error(workspaceValidationError);
    }

    await this.ensureProcess();
    const approvedPolicy = this.shellPolicy;
    await this.requireCommandPermission(command, executionOptions);
    const bashProcess = await this.ensureProcess();
    if (this.shellPolicy !== approvedPolicy) {
      await this.requireCommandPermission(command, executionOptions);
    }

    return this.executeCommand(bashProcess, command, executionOptions.signal);
  }

  private enqueue<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);

    return result;
  }

  private async requireCommandPermission(
    command: string,
    executionOptions: BashToolExecutionOptions,
  ): Promise<void> {
    const assessment = this.shellPolicy.classify(command, {
      currentCwd: this.currentCwd,
      workspace: this.workspace,
    });

    if (assessment.capabilities.some(requiresWorkspaceWrite)) {
      await this.workspace.accessController.requireWrite({
        action: "shell",
        subject: command,
        workspaceId: this.workspace.workspaceId,
      });
    }

    const displayedCommand = truncateText(command.replaceAll(/\s+/gu, " "), 1_000);

    await requestPermissionApproval(
      {
        capabilities: assessment.capabilities,
        action: "execute command",
        metadata: {
          ...(displayedCommand.truncated ? { commandTruncated: "true" } : {}),
          isolation: this.shellPolicy.isolation,
          network: this.shellPolicy.network,
        },
        normalizedAction: assessment.normalizedAction,
        policyId: assessment.policyId,
        reason: assessment.reason,
        risk: assessment.risk,
        subject: displayedCommand.text,
        ...(executionOptions.toolCallId !== undefined
          ? { toolCallId: executionOptions.toolCallId }
          : {}),
        toolName: BASH_TERMINAL_TOOL_DEFINITION.name,
        workspaceId: this.workspace.workspaceId,
      },
      {
        approvalHandler: this.options.permissionApprovalHandler,
        assessment: assessment.decision,
        assessmentHandler: this.options.permissionAssessmentHandler,
      },
    );
  }

  private executeCommand(
    bashProcess: ChildProcessWithoutNullStreams,
    command: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const sentinel = `__YIKU_BASH_DONE_${randomUUID().replaceAll("-", "")}__`;
    const marker = `${sentinel}:`;
    let output = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() => {
          this.stopProcess();
          reject(new Error(`Bash command timed out after ${this.timeoutMs}ms.`));
        });
      }, this.timeoutMs);
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const markerIndex = output.indexOf(marker);

        if (markerIndex === -1) {
          return;
        }

        const markerText = output.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0] ?? "";
        const [exitCodeText = "", encodedCwd = ""] = markerText.split(":", 2);
        const exitCode = Number.parseInt(exitCodeText, 10);
        const cwd = Buffer.from(encodedCwd, "base64").toString("utf8");
        const result = formatBashOutput(
          output.slice(0, markerIndex),
          exitCode,
          this.maxOutputCharacters,
        );

        finish(() => {
          let canonicalCwd: string;
          try {
            canonicalCwd = this.workspace.assertPath(cwd);
          } catch {
            this.stopProcess();
            reject(new Error("Bash command changed cwd outside the workspace."));
            return;
          }
          this.currentCwd = canonicalCwd;
          Promise.resolve(this.options.onCwdChanged?.(canonicalCwd)).then(
            () => resolve(result),
            reject,
          );
        });
      };
      const onError = (error: Error) => {
        finish(() => reject(error));
      };
      const onAbort = () => {
        finish(() => {
          this.stopProcess();
          reject(
            signal?.reason instanceof Error ? signal.reason : new Error("Bash command aborted."),
          );
        });
      };
      const onClose = () => {
        finish(() => {
          this.bashProcess = undefined;
          reject(new Error("Bash session closed before the command completed."));
        });
      };
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        bashProcess.stdout.off("data", onData);
        bashProcess.stderr.off("data", onData);
        bashProcess.off("error", onError);
        bashProcess.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };

      bashProcess.stdout.on("data", onData);
      bashProcess.stderr.on("data", onData);
      bashProcess.once("error", onError);
      bashProcess.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      const completion = [
        command,
        "__yiku_exit=$?",
        "__yiku_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\n')",
        `printf '\\n${marker}%s:%s\\n' "$__yiku_exit" "$__yiku_cwd"`,
        "",
      ].join("\n");
      bashProcess.stdin.write(completion, (error) => {
        if (error) {
          finish(() => reject(error));
        }
      });
    });
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.bashProcess && isProcessRunning(this.bashProcess)) {
      return this.bashProcess;
    }
    this.bashProcess = undefined;

    const lifecycleVersion = this.lifecycleVersion;
    try {
      const process = await this.startProcess(this.activeSandbox);
      if (!this.boundaryReported) {
        this.boundaryReported = true;
        await this.notifyBoundaryChanged({
          from: "uninitialized",
          reason: "Shell runtime boundary initialized.",
          to: this.activeSandbox.isolation,
        });
      }
      return process;
    } catch (error) {
      if (
        lifecycleVersion !== this.lifecycleVersion ||
        this.activeSandbox !== this.preferredSandbox ||
        this.fallbackSandbox === this.preferredSandbox
      ) {
        throw error;
      }

      this.preferredSandbox.close();
      const failedBoundary = this.preferredSandbox.isolation;
      const reason = errorMessage(error);
      const fallbackProcess = await this.startProcess(this.fallbackSandbox);
      this.activeSandbox = this.fallbackSandbox;
      this.shellPolicy = new ShellPolicy({
        allowedNetworkHosts: [...this.shellPolicy.allowedNetworkHosts],
        isolation: this.fallbackSandbox.isolation,
        network: this.fallbackSandbox.network,
      });
      this.boundaryReported = true;
      await this.notifyBoundaryChanged({
        from: failedBoundary,
        reason,
        to: this.fallbackSandbox.isolation,
      });

      return fallbackProcess;
    }
  }

  private async notifyBoundaryChanged(
    change: Parameters<NonNullable<BashTerminalOptions["onBoundaryChanged"]>>[0],
  ): Promise<void> {
    try {
      await this.options.onBoundaryChanged?.(change);
    } catch {
      // Boundary observability must not change Shell execution behavior.
    }
  }

  private async startProcess(
    sandbox: ShellProcessSandbox,
  ): Promise<ChildProcessWithoutNullStreams> {
    const launch = sandbox.createLaunchSpec({
      environment: this.workspace.environment,
      shellPath: this.options.shellPath ?? "/bin/bash",
      workspace: this.workspace,
    });
    let bashProcess: ChildProcessWithoutNullStreams;
    try {
      bashProcess = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        detached: true,
        env: { ...launch.environment },
        stdio: "pipe",
      });
    } catch (error) {
      throw readinessError(sandbox, `spawn failed: ${errorMessage(error)}`);
    }
    this.bashProcess = bashProcess;
    bashProcess.once("close", () => {
      if (this.bashProcess === bashProcess) {
        this.bashProcess = undefined;
      }
    });

    try {
      await this.waitForReadiness(bashProcess, sandbox);
      return bashProcess;
    } catch (error) {
      this.stopProcess(bashProcess);
      throw error;
    }
  }

  private waitForReadiness(
    bashProcess: ChildProcessWithoutNullStreams,
    sandbox: ShellProcessSandbox,
  ): Promise<void> {
    const sentinel = `__YIKU_BASH_READY_${randomUUID().replaceAll("-", "")}__`;
    let stdout = "";
    let stderr = "";
    let stderrTruncated = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() => {
          reject(
            readinessError(
              sandbox,
              `timed out after ${this.startupTimeoutMs}ms`,
              stderr,
              stderrTruncated,
            ),
          );
        });
      }, this.startupTimeoutMs);
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes(sentinel)) {
          finish(resolve);
          return;
        }
        stdout = stdout.slice(-sentinel.length);
      };
      const onStderr = (chunk: Buffer) => {
        const remaining = MAX_STARTUP_STDERR_CHARACTERS - stderr.length;
        if (remaining <= 0) {
          stderrTruncated = true;
          return;
        }
        const text = chunk.toString("utf8");
        stderr += text.slice(0, remaining);
        stderrTruncated ||= text.length > remaining;
      };
      const onError = (error: Error) => {
        finish(() => {
          reject(readinessError(sandbox, error.message, stderr, stderrTruncated));
        });
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        const status =
          code === null
            ? `process closed with signal ${signal ?? "unknown"}`
            : `process exited ${code}`;
        finish(() => {
          reject(readinessError(sandbox, status, stderr, stderrTruncated));
        });
      };
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        bashProcess.stdout.off("data", onStdout);
        bashProcess.stderr.off("data", onStderr);
        bashProcess.off("error", onError);
        bashProcess.off("close", onClose);
        callback();
      };

      bashProcess.stdout.on("data", onStdout);
      bashProcess.stderr.on("data", onStderr);
      bashProcess.once("error", onError);
      bashProcess.once("close", onClose);
      bashProcess.stdin.write(`printf '%s\\n' '${sentinel}'\n`, (error) => {
        if (error) {
          finish(() => {
            reject(readinessError(sandbox, error.message, stderr, stderrTruncated));
          });
        }
      });
    });
  }

  private stopProcess(bashProcess = this.bashProcess): void {
    if (bashProcess === undefined) {
      return;
    }
    if (this.bashProcess === bashProcess) {
      this.bashProcess = undefined;
    }
    if (isProcessRunning(bashProcess)) {
      terminateProcessGroup(bashProcess);
    }
  }

  private get maxOutputCharacters(): number {
    return this.options.maxOutputCharacters ?? DEFAULT_BASH_MAX_OUTPUT_CHARACTERS;
  }

  private get startupTimeoutMs(): number {
    return this.options.startupTimeoutMs ?? DEFAULT_BASH_STARTUP_TIMEOUT_MS;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessRunning(process: ChildProcessWithoutNullStreams): boolean {
  return process.exitCode === null && process.signalCode === null && !process.killed;
}

function readinessError(
  sandbox: ShellProcessSandbox,
  failure: string,
  stderr = "",
  stderrTruncated = false,
): Error {
  const detail = stderr.trim();
  const stderrText = detail
    ? `: ${detail}${stderrTruncated ? "\n[startup stderr truncated]" : ""}`
    : "";

  return new Error(
    `Bash shell readiness ${failure} for ${sandbox.isolation} boundary${stderrText}.`,
  );
}

function requiresWorkspaceWrite(capability: string): boolean {
  return capability.startsWith("workspace.") && capability !== "workspace.read";
}

function validateWorkspaceCommand(
  command: string,
  currentCwd: string,
  workspace: WorkspaceContext,
): string | undefined {
  const cdPattern =
    /(?:^|[\n;&|()])\s*(?:(?:builtin|command)\s+)?cd(?:\s+--)?(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|()]+)))?/giu;
  for (const match of command.matchAll(cdPattern)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target === undefined || target === "-" || target.includes("$")) {
      return "Bash command may not change cwd outside the workspace.";
    }
    let targetPath: string;
    try {
      targetPath = workspace.resolvePath(target, currentCwd);
    } catch {
      return "Bash command may not change cwd outside the authorized filesystem roots.";
    }
    if (!workspace.containsPath(targetPath)) {
      return "Bash command may not change cwd outside the workspace.";
    }
    if (existsSync(targetPath)) {
      try {
        workspace.assertPath(targetPath);
      } catch {
        return "Bash command may not change cwd outside the workspace.";
      }
    }
  }
  return undefined;
}

function formatBashOutput(output: string, exitCode: number, maxOutputCharacters: number): string {
  const trimmedOutput = output.replace(/^\r?\n/, "").replace(/(?:\r?\n)+$/, "");
  const truncatedOutput = truncateText(trimmedOutput, maxOutputCharacters);
  const statusText = Number.isNaN(exitCode) || exitCode === 0 ? "" : `[exit_code: ${exitCode}]`;
  const status = statusText ? `${truncatedOutput.text ? "\n" : ""}${statusText}` : "";
  const truncation = truncatedOutput.truncated
    ? `\n[output truncated after ${maxOutputCharacters} characters]`
    : "";

  return `${truncatedOutput.text}${status}${truncation}`;
}
