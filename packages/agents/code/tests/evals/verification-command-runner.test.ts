import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { VerificationCommand } from "@yiku/evals";
import type {
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
} from "@yiku/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerificationCommandRunner, WorkspaceContext } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("VerificationCommandRunner", () => {
  it("runs structured commands and captures bounded, redacted evidence", async () => {
    const root = await workspace();
    const sandbox = new DirectSandbox();
    const runner = new VerificationCommandRunner({
      maxOutputBytes: 16,
      sandbox,
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const result = await runner.run(
      command("/bin/sh", [
        "-c",
        "printf 'abcdefghijklmnopqrstuvwxyz'; printf 'Bearer secret-value-123456' >&2",
      ]),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(result.stdoutHead).toBe("abcdefghijklmnop");
    expect(result.stdoutTail).toBe("klmnopqrstuvwxyz");
    expect(result.stderrHead).not.toContain("secret-value");
    expect(result.artifact).toMatchObject({
      kind: "command-result",
      metadata: expect.objectContaining({
        exitCode: 0,
        timedOut: false,
      }),
    });
    expect(sandbox.lastInput?.workspaceAccess).toBe("read-only");
    runner.close();
    expect(sandbox.closed).toBe(false);
  });

  it("returns structured failures for non-zero exits and timeouts", async () => {
    const root = await workspace();
    const runner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const failed = await runner.run(command("/bin/sh", ["-c", "exit 7"]));
    const timedOut = await runner.run({
      ...command("/bin/sh", ["-c", "sleep 1"]),
      timeoutMs: 20,
    });

    expect(failed).toMatchObject({
      exitCode: 7,
      timedOut: false,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.signal).toBeDefined();
  });

  it("propagates abort and terminates the process", async () => {
    const root = await workspace();
    const runner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const controller = new AbortController();
    const running = runner.run(
      {
        ...command("/bin/sh", ["-c", "sleep 1"]),
        timeoutMs: 1_000,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancel")), 10);

    await expect(running).rejects.toMatchObject({ code: "EVAL_ABORTED" });
  });

  it("requires explicit isolation for write-producing commands", async () => {
    const root = await workspace();
    const unisolated = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    await expect(
      unisolated.run({
        ...command(process.execPath, ["-e", "process.exit(0)"]),
        writePolicy: "isolated",
      }),
    ).rejects.toMatchObject({ code: "EVAL_PLAN_UNSATISFIABLE" });

    const sandbox = new DirectSandbox();
    const isolated = new VerificationCommandRunner({
      isolatedWorkspace: true,
      sandbox,
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    await expect(
      isolated.run({
        ...command(process.execPath, ["-e", "process.exit(0)"]),
        writePolicy: "isolated",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(sandbox.lastInput?.workspaceAccess).toBe("read-write");
  });

  it("rejects unsupported boundaries, network modes, cwd, and missing executables", async () => {
    const root = await workspace();
    const workspaceContext = new WorkspaceContext({ rootDir: root });
    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox("host-policy"),
        workspace: workspaceContext,
      }).run(command(process.execPath, ["-e", "process.exit(0)"])),
    ).rejects.toMatchObject({ code: "EVAL_PLAN_UNSATISFIABLE" });
    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox(),
        workspace: workspaceContext,
      }).run({
        ...command(process.execPath, ["-e", "process.exit(0)"]),
        network: "allowlist",
      }),
    ).rejects.toMatchObject({ code: "EVAL_PLAN_UNSATISFIABLE" });
    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox(),
        workspace: workspaceContext,
      }).run({
        ...command(process.execPath, ["-e", "process.exit(0)"]),
        cwd: "../outside",
      }),
    ).rejects.toMatchObject({ code: "EVAL_PROFILE_INVALID" });
    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox(),
        workspace: workspaceContext,
      }).run(command("definitely-missing-command")),
    ).rejects.toMatchObject({ code: "EVAL_PROVIDER_UNAVAILABLE" });
  });

  it("validates output limits and every structured command boundary", async () => {
    const root = await workspace();
    const workspaceContext = new WorkspaceContext({ rootDir: root });
    for (const maxOutputBytes of [0, 1.5, 1024 * 1024 + 1]) {
      expect(
        () =>
          new VerificationCommandRunner({
            maxOutputBytes,
            sandbox: new DirectSandbox(),
            workspace: workspaceContext,
          }),
      ).toThrow("output limit");
    }
    const runner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      workspace: workspaceContext,
    });
    for (const invalid of [
      { ...command(process.execPath), id: "../invalid" },
      { ...command(" "), command: " " },
      { ...command(process.execPath), command: "bad\0command" },
      { ...command(process.execPath), args: ["bad\0argument"] },
      { ...command(process.execPath), cwd: root },
      { ...command(process.execPath), cwd: "nested/../outside" },
      { ...command(process.execPath), timeoutMs: 0 },
      { ...command(process.execPath), timeoutMs: 3_600_001 },
      { ...command(process.execPath), envAllowlist: ["INVALID-NAME"] },
      { ...command(process.execPath), envAllowlist: ["PATH", "PATH"] },
    ]) {
      await expect(runner.run(invalid)).rejects.toMatchObject({
        code: "EVAL_PROFILE_INVALID",
      });
    }
  });

  it("propagates pre-abort, sandbox network mismatch, and synchronous spawn failures", async () => {
    const root = await workspace();
    const workspaceContext = new WorkspaceContext({ rootDir: root });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox(),
        workspace: workspaceContext,
      }).run(command(process.execPath), controller.signal),
    ).rejects.toMatchObject({ code: "EVAL_ABORTED" });

    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox("sandbox", "ask"),
        workspace: workspaceContext,
      }).run(command(process.execPath)),
    ).rejects.toMatchObject({ code: "EVAL_PLAN_UNSATISFIABLE" });

    await expect(
      new VerificationCommandRunner({
        sandbox: new DirectSandbox(),
        spawnProcess: (() => {
          throw new Error("spawn failed");
        }) as typeof import("node:child_process").spawn,
        workspace: workspaceContext,
      }).run(command(process.execPath)),
    ).rejects.toMatchObject({ code: "EVAL_PROVIDER_UNAVAILABLE" });
  });

  it("resolves PATH candidates, filters environment variables, and reports signal exits", async () => {
    const root = await workspace();
    const executableDirectory = dirname(process.execPath);
    const runner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      workspace: new WorkspaceContext({
        environment: {
          CI: "visible",
          DROP: "hidden",
          PATH: `${join(root, "missing")}:${executableDirectory}`,
        },
        rootDir: root,
      }),
    });
    const environment = await runner.run({
      ...command(basename(process.execPath), [
        "-e",
        "process.stdout.write(String(process.env.CI) + ':' + (process.env.DROP ?? ''))",
      ]),
      envAllowlist: ["PATH", "CI"],
    });
    expect(environment.stdoutHead).toBe("visible:");

    const signalled = await runner.run(command("/bin/sh", ["-c", "kill -TERM $$"]));
    expect(signalled).toMatchObject({
      signal: "SIGTERM",
      timedOut: false,
    });
  });

  it("handles late aborts and child closures without exit metadata", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const abortedChild = fakeChild();
    const abortedRunner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      spawnProcess: (() => {
        controller.abort(new Error("late abort"));
        return abortedChild;
      }) as typeof import("node:child_process").spawn,
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    await expect(
      abortedRunner.run(command(process.execPath), controller.signal),
    ).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    expect(abortedChild.kill).toHaveBeenCalledWith("SIGTERM");

    const exitedController = new AbortController();
    const exitedChild = fakeChild();
    Object.defineProperty(exitedChild, "exitCode", { value: 0 });
    const exitedRunner = new VerificationCommandRunner({
      sandbox: new DirectSandbox(),
      spawnProcess: (() => {
        exitedController.abort(new Error("late abort"));
        return exitedChild;
      }) as typeof import("node:child_process").spawn,
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    await expect(
      exitedRunner.run(command(process.execPath), exitedController.signal),
    ).rejects.toMatchObject({ code: "EVAL_ABORTED" });
    expect(exitedChild.kill).not.toHaveBeenCalled();

    const completedChild = fakeChild();
    const completedRunner = new VerificationCommandRunner({
      maxOutputBytes: 2,
      sandbox: new DirectSandbox(),
      spawnProcess: (() => {
        queueMicrotask(() => {
          completedChild.stdout.write(Buffer.from("ab"));
          completedChild.stdout.write(Buffer.from("cd"));
          completedChild.emit("close", null, null);
        });
        return completedChild;
      }) as typeof import("node:child_process").spawn,
      workspace: new WorkspaceContext({ rootDir: root }),
    });
    const completed = await completedRunner.run(command(process.execPath));
    expect(completed).toMatchObject({
      stdoutHead: "ab",
      stdoutTail: "cd",
      timedOut: false,
    });
    expect(completed).not.toHaveProperty("exitCode");
    expect(completed).not.toHaveProperty("signal");
  });
});

class DirectSandbox implements ShellProcessSandbox {
  public closed = false;
  public readonly isolation;
  public lastInput: ShellSandboxLaunchInput | undefined;
  public readonly network;

  public constructor(
    isolation: ShellProcessSandbox["isolation"] = "sandbox",
    network: ShellProcessSandbox["network"] = "deny",
  ) {
    this.isolation = isolation;
    this.network = network;
  }

  public close(): void {
    this.closed = true;
  }

  public createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    this.lastInput = input;
    return {
      args: [],
      command: input.shellPath,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: input.environment,
    };
  }
}

function command(executable: string, args: readonly string[] = []): VerificationCommand {
  return {
    args,
    command: executable,
    cwd: ".",
    envAllowlist: [],
    id: "test-command",
    network: "deny",
    timeoutMs: 1_000,
    writePolicy: "read-only",
  };
}

async function workspace(): Promise<string> {
  const directory = join(
    tmpdir(),
    `yiku-verification-command-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    exitCode: null,
    kill: vi.fn(() => true),
    pid: undefined,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  return child;
}
