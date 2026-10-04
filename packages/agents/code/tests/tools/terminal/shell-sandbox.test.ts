import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPolicyShellSandbox, type ShellProcessSandbox } from "@yiku/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../../src/permission/index.js";
import { BashTerminal } from "../../../src/tools/terminal/bash-terminal.js";

const COMMAND_TIMEOUT_MS = 5_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("BashTerminal sandbox integration", () => {
  it("falls back when the preferred sandbox probe throws synchronously", async () => {
    const workspace = await temporaryDirectory("probe-fallback-workspace");
    const outsideDirectory = await temporaryDirectory("probe-fallback-outside");
    const outsideFile = join(outsideDirectory, "secret.txt");
    await writeFile(outsideFile, "host-secret");
    const close = vi.fn();
    const preferred: ShellProcessSandbox = {
      close,
      createLaunchSpec: () => {
        throw new Error("probe failed synchronously");
      },
      isolation: "sandbox",
      network: "deny",
    };
    const boundaries: Array<{ from: string; reason: string; to: string }> = [];
    const permissionRequests: PermissionRequest[] = [];
    const terminal = new BashTerminal({
      cwd: workspace,
      fallbackSandbox: new HostPolicyShellSandbox("ask"),
      onBoundaryChanged: (change) => boundaries.push(change),
      permissionApprovalHandler: (request) => {
        permissionRequests.push(request);
        return { decision: "deny", reason: "test denial" };
      },
      shellSandbox: preferred,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "printf fallback-ok" })).resolves.toBe(
        "fallback-ok",
      );
      await expect(terminal.execute({ command: `cat '${outsideFile}'` })).rejects.toThrow(
        "Denied by runtime permission policy",
      );
      await expect(terminal.execute({ command: "curl https://example.test" })).rejects.toThrow(
        "test denial",
      );
      expect(permissionRequests).toEqual([
        expect.objectContaining({
          metadata: {
            isolation: "host-policy",
            network: "ask",
          },
          policyId: "shell-network-approval",
        }),
      ]);
      expect(boundaries).toEqual([
        {
          from: "sandbox",
          reason: expect.stringContaining("probe failed synchronously"),
          to: "host-policy",
        },
      ]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      terminal.close();
    }
  });

  it("captures readiness stderr before falling back", async () => {
    const workspace = await temporaryDirectory("readiness-stderr-workspace");
    const boundaries: Array<{ from: string; reason: string; to: string }> = [];
    const terminal = new BashTerminal({
      cwd: workspace,
      fallbackSandbox: new HostPolicyShellSandbox(),
      onBoundaryChanged: (change) => boundaries.push(change),
      shellSandbox: launchScriptSandbox("printf 'startup stderr detail' >&2; exit 23"),
      startupTimeoutMs: 500,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "printf recovered" })).resolves.toBe("recovered");
      expect(boundaries).toEqual([
        {
          from: "sandbox",
          reason: expect.stringMatching(/readiness.*startup stderr detail/iu),
          to: "host-policy",
        },
      ]);
    } finally {
      terminal.close();
    }
  });

  it("reports a successful boundary once and ignores observer failures", async () => {
    const workspace = await temporaryDirectory("boundary-ready-workspace");
    const onBoundaryChanged = vi.fn(() => {
      throw new Error("observer failed");
    });
    const terminal = new BashTerminal({
      cwd: workspace,
      onBoundaryChanged,
      shellSandbox: new HostPolicyShellSandbox(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "printf first" })).resolves.toBe("first");
      await expect(terminal.execute({ command: "printf second" })).resolves.toBe("second");
      expect(onBoundaryChanged).toHaveBeenCalledOnce();
      expect(onBoundaryChanged).toHaveBeenCalledWith({
        from: "uninitialized",
        reason: "Shell runtime boundary initialized.",
        to: "host-policy",
      });
    } finally {
      terminal.close();
    }
  });

  it("times out readiness before falling back", async () => {
    const workspace = await temporaryDirectory("readiness-timeout-workspace");
    const boundaries: Array<{ from: string; reason: string; to: string }> = [];
    const terminal = new BashTerminal({
      cwd: workspace,
      fallbackSandbox: new HostPolicyShellSandbox(),
      onBoundaryChanged: (change) => boundaries.push(change),
      shellSandbox: launchScriptSandbox("printf 'waiting for readiness' >&2; sleep 1"),
      startupTimeoutMs: 100,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "printf recovered" })).resolves.toBe("recovered");
      expect(boundaries).toEqual([
        {
          from: "sandbox",
          reason: expect.stringMatching(/readiness timed out.*waiting for readiness/iu),
          to: "host-policy",
        },
      ]);
    } finally {
      terminal.close();
    }
  });

  it("enforces the current platform boundary or an explicit host-policy fallback", async () => {
    const workspace = await temporaryDirectory("functional-workspace");
    const outsideDirectory = await temporaryDirectory("functional-outside");
    const outsideFile = join(outsideDirectory, "secret.txt");
    await writeFile(outsideFile, "sandbox-secret");
    const boundaries: Array<{ from: string; reason: string; to: string }> = [];
    const terminal = new BashTerminal({
      cwd: workspace,
      onBoundaryChanged: (change) => boundaries.push(change),
      permissionApprovalHandler: () => ({ decision: "allow" }),
      timeoutMs: 5_000,
    });

    try {
      await expect(terminal.execute({ command: "printf sandbox-ok" })).resolves.toBe("sandbox-ok");

      if (boundaries.at(-1)?.to !== "host-policy") {
        expect(boundaries).toEqual([
          {
            from: "uninitialized",
            reason: "Shell runtime boundary initialized.",
            to: expect.stringMatching(/container|sandbox/u),
          },
        ]);
        const escapedRead = await terminal.execute({
          command: `bash -c "cat '${outsideFile}'"`,
        });
        expect(escapedRead).not.toContain("sandbox-secret");
      } else {
        await expect(terminal.execute({ command: `cat '${outsideFile}'` })).rejects.toThrow(
          "Denied by runtime permission policy",
        );
        expect(boundaries).toEqual([
          expect.objectContaining({
            from: expect.stringMatching(/container|sandbox/u),
            to: "host-policy",
          }),
        ]);
      }
    } finally {
      terminal.close();
    }
  });
});

function launchScriptSandbox(script: string): ShellProcessSandbox {
  return {
    close: () => undefined,
    createLaunchSpec: (input) => ({
      args: ["--noprofile", "--norc", "-c", script],
      command: input.shellPath,
      cwd: input.workspace.rootDir,
      environment: input.environment,
    }),
    isolation: "sandbox",
    network: "deny",
  };
}

async function temporaryDirectory(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `yiku-${name}-`));
  temporaryDirectories.push(parent);
  const directory = join(parent, name);
  await mkdir(directory);
  return directory;
}
