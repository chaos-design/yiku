import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type PermissionRequest, ShellPolicy } from "../../../src/permission/index.js";
import { WorkspaceContext } from "../../../src/tools/common/workspace-context.js";
import { BashTerminal } from "../../../src/tools/terminal/bash-terminal.js";
import { bashTool } from "../../../src/tools/terminal/index.js";
import {
  BASH_TERMINAL_TOOL_DEFINITION,
  bashToolInputSchema,
} from "../../../src/tools/terminal/types.js";
import { HOST_SHELL_SANDBOX } from "./host-shell-sandbox.js";

const COMMAND_TIMEOUT_MS = 5_000;

describe("BashTerminal", () => {
  it("executes commands in a persistent bash session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-bash-"));
    const terminal = new BashTerminal({
      cwd: tempDir,
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      const nestedDir = join(tempDir, "nested");
      await mkdir(nestedDir);
      const canonicalNestedDir = await realpath(nestedDir);
      await expect(terminal.execute({ command: "pwd" })).resolves.toContain(tempDir);
      await terminal.execute({ command: "cd nested" });
      await expect(terminal.execute({ command: "pwd" })).resolves.toBe(canonicalNestedDir);
      await expect(terminal.execute({ command: "cd /" })).rejects.toThrow(
        "may not change cwd outside",
      );
      await expect(terminal.reset()).resolves.toBeUndefined();
      await expect(terminal.execute({ command: "pwd" })).resolves.toContain(tempDir);
    } finally {
      terminal.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reports exit codes and truncates large output", async () => {
    const terminal = new BashTerminal({
      maxOutputCharacters: 8,
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "printf '1234567890abcdef'" })).resolves.toBe(
        "12345678\n[output truncated after 8 characters]",
      );
      await expect(terminal.execute({ command: "false" })).resolves.toBe("[exit_code: 1]");
    } finally {
      terminal.close();
    }
  });

  it("reports the persistent shell working directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-bash-cwd-"));
    const nestedDir = join(tempDir, "nested");
    await mkdir(nestedDir);
    const canonicalNestedDir = await realpath(nestedDir);
    const directories: string[] = [];
    const terminal = new BashTerminal({
      cwd: tempDir,
      onCwdChanged: (cwd) => {
        directories.push(cwd);
      },
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await terminal.execute({ command: "cd nested" });
      await terminal.execute({ command: "pwd" });
    } finally {
      terminal.close();
      await rm(tempDir, { force: true, recursive: true });
    }

    expect(directories).toEqual([canonicalNestedDir, canonicalNestedDir]);
  });

  it("resets cleanly before a bash session exists", async () => {
    const terminal = new BashTerminal({ shellSandbox: HOST_SHELL_SANDBOX });

    await expect(terminal.reset()).resolves.toBeUndefined();
    terminal.close();
  });

  it("rejects a Shell Policy that overstates the configured boundary", () => {
    expect(
      () =>
        new BashTerminal({
          shellPolicy: new ShellPolicy({ isolation: "sandbox", network: "deny" }),
          shellSandbox: HOST_SHELL_SANDBOX,
        }),
    ).toThrow("must match");
  });

  it("rejects invalid commands and recovers after timeout", async () => {
    const terminal = new BashTerminal({
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: 500,
      validateCommand: (command) => (command === "blocked" ? "Command is blocked." : undefined),
    });

    try {
      await expect(terminal.execute({ command: "" })).rejects.toThrow("Bash command is required.");
      await expect(terminal.execute({ command: "blocked" })).rejects.toThrow("Command is blocked.");
      await expect(terminal.execute({ command: "sleep 2" })).rejects.toThrow(
        "Bash command timed out after 500ms.",
      );
      await expect(terminal.execute({ command: "echo recovered" })).resolves.toBe("recovered");
    } finally {
      terminal.close();
    }
  });

  it("requires permission before running high-risk commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-bash-permission-"));
    const permissionRequests: PermissionRequest[] = [];
    const terminal = new BashTerminal({
      cwd: tempDir,
      permissionApprovalHandler: async (request) => {
        permissionRequests.push(request);

        return { decision: "allow", reason: "approved" };
      },
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(
        terminal.execute({ command: "rm -rf ./missing-file" }, { toolCallId: "call-1" }),
      ).resolves.toBe("");
    } finally {
      terminal.close();
      await rm(tempDir, { force: true, recursive: true });
    }

    expect(permissionRequests).toEqual([
      {
        action: "execute command",
        capabilities: ["process.execute", "workspace.delete"],
        metadata: {
          isolation: "host-policy",
          network: "ask",
        },
        normalizedAction: "recursively force-remove workspace paths",
        policyId: "recursive-force-rm",
        reason: "recursively force-removes files or directories",
        risk: "high",
        subject: "rm -rf ./missing-file",
        toolCallId: "call-1",
        toolName: "bashTool",
        workspaceId: expect.any(String),
      },
    ]);
  });

  it("denies high-risk commands when no permission approval handler is configured", async () => {
    const terminal = new BashTerminal({
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "git reset --hard" })).rejects.toThrow(
        "Permission denied for bashTool execute command: No permission approval handler configured.",
      );
      await expect(terminal.execute({ command: "echo safe" })).resolves.toBe("safe");
    } finally {
      terminal.close();
    }
  });

  it("applies configured assessments to commands allowed by the runtime policy", async () => {
    const assessmentHandler = vi.fn(() => "deny" as const);
    const terminal = new BashTerminal({
      permissionAssessmentHandler: assessmentHandler,
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(terminal.execute({ command: "cat README.md" })).rejects.toThrow(
        "Denied by configured permission policy",
      );
      expect(assessmentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          policyId: "known-low-risk-command",
          subject: "cat README.md",
        }),
        "allow",
      );
    } finally {
      terminal.close();
    }
  });

  it("denies hard policy before approval and allows regular workspace writes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-bash-deny-"));
    const outsidePath = `${tempDir}-outside.txt`;
    const approvalHandler = vi.fn(() => ({ decision: "allow" as const }));
    const terminal = new BashTerminal({
      cwd: tempDir,
      permissionApprovalHandler: approvalHandler,
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(
        terminal.execute({ command: "sudo touch should-not-exist.txt" }),
      ).rejects.toThrow("Denied by runtime permission policy");
      await expect(terminal.execute({ command: "cat /etc/passwd" })).rejects.toThrow(
        "Denied by runtime permission policy",
      );
      await expect(
        terminal.execute({ command: `echo blocked > "${outsidePath}"` }),
      ).rejects.toThrow("Denied by runtime permission policy");
      await expect(access(join(tempDir, "should-not-exist.txt"))).rejects.toThrow();
      await expect(access(outsidePath)).rejects.toThrow();
      await expect(terminal.execute({ command: "touch regular-write.txt" })).resolves.toBe("");
      await expect(access(join(tempDir, "regular-write.txt"))).resolves.toBeUndefined();
      expect(approvalHandler).not.toHaveBeenCalled();
    } finally {
      terminal.close();
      await rm(tempDir, { force: true, recursive: true });
      await rm(outsidePath, { force: true });
    }
  });

  it("writes only to the workspace and configured Yiku root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yiku-bash-roots-"));
    const workspaceDir = join(parent, "workspace");
    const homeDir = join(parent, "home");
    const yikuDir = join(homeDir, ".yiku");
    const outsideDir = join(homeDir, "outside");
    await mkdir(workspaceDir);
    await mkdir(yikuDir, { recursive: true });
    await mkdir(outsideDir);
    await symlink(outsideDir, join(yikuDir, "escape"));
    const workspace = new WorkspaceContext({
      additionalRootDirs: [yikuDir],
      homeDir,
      rootDir: workspaceDir,
    });
    const canonicalYikuDir =
      workspace.rootDirs.find((path) => path !== workspace.rootDir) ?? yikuDir;
    const terminal = new BashTerminal({
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
      workspace,
    });

    try {
      await expect(
        terminal.execute({ command: "printf 'model=test\\n' > ~/.yiku/.env" }),
      ).resolves.toBe("");
      await expect(terminal.execute({ command: "cd ~/.yiku && pwd" })).resolves.toBe(
        canonicalYikuDir,
      );
      await expect(terminal.execute({ command: "touch nested.txt" })).resolves.toBe("");
      await expect(readFile(join(yikuDir, ".env"), "utf8")).resolves.toBe("model=test\n");
      await expect(access(join(yikuDir, "nested.txt"))).resolves.toBeUndefined();
      await expect(terminal.execute({ command: "printf blocked > ~/outside.txt" })).rejects.toThrow(
        "Denied by runtime permission policy",
      );
      await expect(
        terminal.execute({ command: `printf blocked > "${homeDir}/.yiku-backup"` }),
      ).rejects.toThrow("Denied by runtime permission policy");
      await expect(
        terminal.execute({ command: "touch ~/.yiku/escape/blocked.txt" }),
      ).rejects.toThrow("Denied by runtime permission policy");
      await expect(access(join(homeDir, "outside.txt"))).rejects.toThrow();
      await expect(access(join(homeDir, ".yiku-backup"))).rejects.toThrow();
      await expect(access(join(outsideDir, "blocked.txt"))).rejects.toThrow();
    } finally {
      terminal.close();
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("does not retry a command after writing it to the shell", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "yiku-bash-no-retry-"));
    const counterPath = join(tempDir, "counter.txt");
    const terminal = new BashTerminal({
      cwd: tempDir,
      permissionApprovalHandler: () => ({ decision: "allow" }),
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    try {
      await expect(
        terminal.execute({
          command: "printf 'executed\\n' >> counter.txt; exit 17",
        }),
      ).rejects.toThrow("closed before the command completed");
      await expect(readFile(counterPath, "utf8")).resolves.toBe("executed\n");
    } finally {
      terminal.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("bashTool", () => {
  it("creates an atomic bash function tool", () => {
    const bashFunctionTool = bashTool({
      executor: {
        execute: async () => "ok",
      },
    });

    expect(BASH_TERMINAL_TOOL_DEFINITION).toEqual({
      name: "bashTool",
      type: "bash_20250124",
    });
    expect(bashFunctionTool.name).toBe("bashTool");
    expect(bashFunctionTool.parameters).toBeDefined();
    expect(bashToolInputSchema.parse({ command: "pwd" })).toEqual({ command: "pwd" });
    expect(() => bashToolInputSchema.parse({ restart: true })).toThrow();
    expect(() => bashToolInputSchema.parse({ command: "pwd", restart: true })).toThrow();
  });

  it("invokes the executor and formats tool errors", async () => {
    const bashFunctionTool = bashTool({
      executor: {
        execute: async (input) => {
          if (input.command === "fail") {
            throw new Error("failed command");
          }

          return `ran ${input.command}`;
        },
      },
    });

    await expect(
      bashFunctionTool.invoke({} as never, JSON.stringify({ command: "pwd" })),
    ).resolves.toBe("ran pwd");
    await expect(
      bashFunctionTool.invoke({} as never, JSON.stringify({ command: "fail" })),
    ).resolves.toBe("Error: failed command");
  });

  it("formats permission denial errors", async () => {
    const bashFunctionTool = bashTool({
      permissionApprovalHandler: () => ({
        decision: "deny",
        reason: "human rejected",
      }),
    });

    await expect(
      bashFunctionTool.invoke({} as never, JSON.stringify({ command: "git reset --hard" })),
    ).resolves.toBe("Error: Permission denied for bashTool execute command: human rejected");
  });
});
