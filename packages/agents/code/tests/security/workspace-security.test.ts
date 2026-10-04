import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeToolset, EnvironmentPolicy, WorkspaceContext } from "../../src/index.js";
import { PathBoundary } from "../../src/tools/common/path-boundary.js";
import { TextEditor } from "../../src/tools/edit/text-editor.js";
import { listDirectory } from "../../src/tools/fs/ls.js";
import { BashTerminal } from "../../src/tools/terminal/bash-terminal.js";
import { HOST_SHELL_SANDBOX } from "../tools/terminal/host-shell-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Workspace security", () => {
  it("keeps interleaved toolsets bound to their construction workspace", async () => {
    const parent = await temporaryDirectory();
    const workspaceA = join(parent, "workspace-a");
    const workspaceB = join(parent, "workspace-b");
    await mkdir(workspaceA);
    await mkdir(workspaceB);
    await writeFile(join(workspaceA, "only-a.txt"), "workspace a\n");
    await writeFile(join(workspaceB, "only-b.txt"), "workspace b\n");
    const toolsetA = new CodeToolset({
      workspace: new WorkspaceContext({ accessMode: "read-only", rootDir: workspaceA }),
    });
    const toolsetB = new CodeToolset({
      workspace: new WorkspaceContext({ accessMode: "read-only", rootDir: workspaceB }),
    });
    const lsA = toolsetA.tools.find((tool) => tool.name === "lsTool");
    const lsB = toolsetB.tools.find((tool) => tool.name === "lsTool");

    try {
      const outputs = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          (index % 2 === 0 ? lsA : lsB)?.invoke({} as never, JSON.stringify({ path: "." })),
        ),
      );
      for (const [index, output] of outputs.entries()) {
        expect(output).toContain(index % 2 === 0 ? "only-a.txt" : "only-b.txt");
        expect(output).not.toContain(index % 2 === 0 ? "only-b.txt" : "only-a.txt");
      }
    } finally {
      toolsetA.close();
      toolsetB.close();
    }
  });

  it("rejects read and write access through escaping symbolic links", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(workspace, "escape"));
    await symlink(join(outside, "secret.txt"), join(workspace, "secret-link.txt"));
    const editor = new TextEditor({ rootDir: workspace });

    await expect(listDirectory({ path: "escape", rootDir: workspace })).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE",
    });
    await expect(
      editor.execute({ command: "view", path: "secret-link.txt" }),
    ).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE",
    });
    await expect(
      editor.execute({
        command: "str_replace",
        new_str: "changed",
        old_str: "secret",
        path: "secret-link.txt",
      }),
    ).rejects.toMatchObject({
      code: "SYMLINK_WRITE_DENIED",
    });
    await expect(
      editor.execute({
        command: "create",
        file_text: "blocked",
        path: "escape/new.txt",
      }),
    ).rejects.toMatchObject({
      code: "SYMLINK_WRITE_DENIED",
    });
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret\n");
  });

  it("allows the configured Yiku root without opening the rest of Home", async () => {
    const parent = await temporaryDirectory();
    const workspaceDir = join(parent, "workspace");
    const homeDir = join(parent, "home");
    const yikuDir = join(homeDir, ".yiku");
    const outsideDir = join(homeDir, "outside");
    await mkdir(workspaceDir);
    await mkdir(yikuDir, { recursive: true });
    await mkdir(outsideDir);
    await writeFile(join(yikuDir, ".env"), "AI_MODEL=old\n");
    await writeFile(join(outsideDir, "secret.txt"), "secret\n");
    await symlink(outsideDir, join(yikuDir, "escape"));
    const workspace = new WorkspaceContext({
      additionalRootDirs: [yikuDir],
      homeDir,
      rootDir: workspaceDir,
    });
    const editor = new TextEditor({ workspace });

    await expect(
      editor.execute({
        command: "str_replace",
        new_str: "AI_MODEL=new",
        old_str: "AI_MODEL=old",
        path: "~/.yiku/.env",
      }),
    ).resolves.toContain("Successfully replaced");
    await expect(
      editor.execute({
        command: "create",
        file_text: "enabled=true\n",
        path: "~/.yiku/nested/settings.txt",
      }),
    ).resolves.toContain(join(yikuDir, "nested", "settings.txt"));
    await expect(readFile(join(yikuDir, ".env"), "utf8")).resolves.toBe("AI_MODEL=new\n");
    await expect(readFile(join(yikuDir, "nested", "settings.txt"), "utf8")).resolves.toBe(
      "enabled=true\n",
    );
    await expect(
      editor.execute({
        command: "create",
        file_text: "blocked",
        path: "~/outside/blocked.txt",
      }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(
      editor.execute({
        command: "create",
        file_text: "blocked",
        path: join(parent, "other", "blocked.txt"),
      }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(
      editor.execute({
        command: "create",
        file_text: "blocked",
        path: "~/.yiku/escape/blocked.txt",
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_WRITE_DENIED" });
  });

  it("allows internal read links but rejects linked writes and stale file identities", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, "actual"));
    await writeFile(join(workspace, "actual/file.txt"), "original\n");
    await symlink(join(workspace, "actual"), join(workspace, "linked"));
    const editor = new TextEditor({ rootDir: workspace });

    await expect(editor.execute({ command: "view", path: "linked/file.txt" })).resolves.toContain(
      "original",
    );
    await expect(
      editor.execute({
        command: "str_replace",
        new_str: "changed",
        old_str: "original",
        path: "linked/file.txt",
      }),
    ).rejects.toMatchObject({
      code: "SYMLINK_WRITE_DENIED",
    });

    const boundary = new PathBoundary({ rootDir: workspace });
    const writable = await boundary.resolveWritablePath("actual/file.txt");
    await writeFile(writable.path, "externally changed\n");
    await expect(boundary.assertUnchanged(writable.path, writable.identity)).rejects.toMatchObject({
      code: "PATH_CHANGED",
    });
  });

  it("sanitizes Shell environment variables with a non-overridable denylist", async () => {
    const workspaceDir = await temporaryDirectory();
    const policy = new EnvironmentPolicy({ allowedNames: ["BUILD_MODE"] });
    const workspace = new WorkspaceContext({
      environment: {
        BUILD_MODE: "test",
        BUILD_TOKEN: "hidden-token",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "hidden-key",
        PATH: process.env.PATH,
      },
      environmentPolicy: policy,
      rootDir: workspaceDir,
    });
    const terminal = new BashTerminal({
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: 1_000,
      workspace,
    });

    try {
      await expect(
        terminal.execute({
          command: 'printf \'%s|%s|%s|%s\' "$BUILD_MODE" "$LANG" "$BUILD_TOKEN" "$OPENAI_API_KEY"',
        }),
      ).resolves.toBe("test|en_US.UTF-8||");
    } finally {
      terminal.close();
    }

    expect(() => new EnvironmentPolicy({ allowedNames: ["CUSTOM_API_KEY"] })).toThrow(
      "cannot be exposed",
    );
  });

  it("classifies wrapped destructive and network commands before execution", async () => {
    const workspaceDir = await temporaryDirectory();
    const terminal = new BashTerminal({
      cwd: workspaceDir,
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: 1_000,
    });

    try {
      for (const command of [
        "/bin/rm -rf ./target",
        "command rm -rf ./target",
        'bash -c "rm -rf ./target"',
        "git -C . reset --hard",
        "curl https://example.test",
      ]) {
        await expect(terminal.execute({ command })).rejects.toThrow("Permission denied");
      }
    } finally {
      terminal.close();
    }
  });

  it("validates Workspace Context and environment policy configuration", async () => {
    const workspaceDir = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const workspace = new WorkspaceContext({
      accessMode: "read-only",
      environment: {
        BUILD_MODE: undefined,
        PATH: "/usr/bin",
      },
      rootDir: workspaceDir,
    });

    expect(workspace.containsPath(workspace.rootDir)).toBe(true);
    expect(workspace.containsPath(outside)).toBe(false);
    expect(() => workspace.assertPath(outside)).toThrow("must stay within");
    expect(() => new WorkspaceContext({ rootDir: join(workspaceDir, "missing") })).toThrow(
      "must exist",
    );
    expect(() => new EnvironmentPolicy({ allowedNames: [" "] })).toThrow("non-empty");
    expect(() => new EnvironmentPolicy({ allowedNames: ["AWS_PROFILE"] })).toThrow(
      "cannot be exposed",
    );
    expect(
      () =>
        new CodeToolset({
          accessMode: "read-write",
          workspace,
        }),
    ).toThrow("must match");
  });

  it("rejects invalid creatable parents and detects deleted write targets", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, "parent.txt"), "parent\n");
    await writeFile(join(workspace, "target.txt"), "target\n");
    const boundary = new PathBoundary({ rootDir: workspace });
    const writable = await boundary.resolveWritablePath("target.txt");

    await expect(boundary.resolveCreatablePath("parent.txt/child.txt")).rejects.toThrow(
      "nearest existing parent",
    );
    await rm(writable.path);
    await expect(boundary.assertUnchanged(writable.path, writable.identity)).rejects.toMatchObject({
      code: "PATH_CHANGED",
    });
  });

  it("rejects conflicting Bash options, cancellation, and indirect cwd escape", async () => {
    const workspaceDir = await temporaryDirectory();
    const nestedDir = join(workspaceDir, "nested");
    await mkdir(nestedDir);
    const workspace = new WorkspaceContext({ rootDir: workspaceDir });

    expect(() => new BashTerminal({ cwd: nestedDir, workspace })).toThrow("must match");
    expect(() => new BashTerminal({ env: { PATH: "/usr/bin" }, workspace })).toThrow(
      "configured through",
    );

    const terminal = new BashTerminal({
      shellSandbox: HOST_SHELL_SANDBOX,
      timeoutMs: 1_000,
      workspace,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    try {
      await expect(
        terminal.execute({ command: "echo never" }, { signal: controller.signal }),
      ).rejects.toThrow("cancelled");
      await expect(terminal.execute({ command: "f(){ cd /; }; f" })).rejects.toThrow(
        "Denied by runtime permission policy",
      );
      await expect(terminal.execute({ command: "pwd" })).resolves.toBe(workspace.rootDir);
    } finally {
      terminal.close();
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-workspace-security-"));
  temporaryDirectories.push(directory);
  return directory;
}
