import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostPolicyShellSandbox,
  PlatformShellSandbox,
  ShellSandboxUnavailableError,
  type ShellSandboxWorkspace,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("HostPolicyShellSandbox", () => {
  it("builds a direct host launch description", async () => {
    const rootDir = await temporaryDirectory("host-policy-workspace");
    const sandbox = new HostPolicyShellSandbox("ask");
    const spec = sandbox.createLaunchSpec({
      cwd: rootDir,
      environment: { PATH: "/usr/bin:/bin" },
      shellPath: "/bin/bash",
      workspace: workspace(rootDir),
    });

    expect(spec).toEqual({
      args: ["--noprofile", "--norc"],
      command: "/bin/bash",
      cwd: rootDir,
      environment: { PATH: "/usr/bin:/bin" },
    });
    expect(sandbox.isolation).toBe("host-policy");
    expect(sandbox.network).toBe("ask");
    expect(() => sandbox.close()).not.toThrow();
  });
});

describe("PlatformShellSandbox", () => {
  it("builds a macOS profile with authorized writes but no Home-wide access", async () => {
    const rootDir = await temporaryDirectory("workspace");
    const homeDir = await temporaryDirectory("home");
    const yikuDir = join(homeDir, ".yiku");
    await mkdir(yikuDir);
    const sandboxTemp = await temporaryDirectory('sandbox"temp');
    const sandbox = new PlatformShellSandbox({
      platform: "darwin",
      sandboxExecutable: "/test/sandbox-exec",
      skipAvailabilityCheck: true,
      tempDirectory: sandboxTemp,
    });
    const workspaceContext = workspace(rootDir, {
      additionalRootDirs: [yikuDir],
      homeDir,
    });
    const spec = sandbox.createLaunchSpec({
      environment: { PATH: "/usr/bin:/bin" },
      shellPath: "/bin/bash",
      workspace: workspaceContext,
    });
    const profile = spec.args[1] ?? "";
    const canonicalSandboxTemp = dirname(spec.environment.TMPDIR ?? "");

    expect(spec.command).toBe("/test/sandbox-exec");
    expect(spec.args[0]).toBe("-p");
    expect(spec.args.at(-1)).toBe("/bin/bash");
    expect(spec.cwd).toBe(rootDir);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process*)");
    expect(profile).toContain(`(subpath "${rootDir}")`);
    expect(profile).toContain(`(subpath "${yikuDir}")`);
    expect(profile).not.toContain(`(subpath "${homeDir}")`);
    expect(profile).toContain('\\"');
    expect(profile).toContain("(allow network*)");
    expect(spec.environment.HOME).toBe(homeDir);
    expect(spec.environment.TMPDIR).toBe(join(canonicalSandboxTemp, "tmp"));
    await expect(access(join(canonicalSandboxTemp, "home"))).resolves.toBeUndefined();

    sandbox.close();
    await expect(access(sandboxTemp)).resolves.toBeUndefined();
  });

  it("removes an internally owned macOS temporary directory on close", async () => {
    const rootDir = await temporaryDirectory("owned-temp-workspace");
    const sandbox = new PlatformShellSandbox({
      platform: "darwin",
      sandboxExecutable: "/test/sandbox-exec",
      skipAvailabilityCheck: true,
    });
    const spec = sandbox.createLaunchSpec({
      environment: {},
      shellPath: "/bin/bash",
      workspace: workspace(rootDir),
    });
    const sandboxTemp = dirname(spec.environment.TMPDIR ?? "");

    await expect(access(sandboxTemp)).resolves.toBeUndefined();
    sandbox.close();
    await expect(access(sandboxTemp)).rejects.toThrow();
    expect(() => sandbox.close()).not.toThrow();
  });

  it("builds a rootless Linux bubblewrap boundary", async () => {
    const rootDir = await temporaryDirectory("linux-workspace");
    const nestedRoot = join(rootDir, "nested");
    await mkdir(nestedRoot);
    const homeDir = await temporaryDirectory("linux-home");
    const yikuDir = join(homeDir, ".yiku");
    await mkdir(yikuDir);
    const sandbox = new PlatformShellSandbox({
      platform: "linux",
      sandboxExecutable: "/test/bwrap",
      skipAvailabilityCheck: true,
    });
    const workspaceContext = workspace(rootDir, {
      additionalRootDirs: [nestedRoot, yikuDir],
      homeDir,
    });
    const spec = sandbox.createLaunchSpec({
      environment: { PATH: "/:/usr/bin:/bin" },
      shellPath: "/bin/bash",
      workspace: workspaceContext,
    });

    expect(spec.command).toBe("/test/bwrap");
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--unshare-all",
        "--cap-drop",
        "ALL",
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        "/bin",
        "/bin",
        "--bind",
        rootDir,
        rootDir,
        "--bind",
        yikuDir,
        yikuDir,
        "--setenv",
        "HOME",
        homeDir,
        "--chdir",
        rootDir,
        "--",
        "/bin/bash",
      ]),
    );
    expect(spec.args.join(" ")).not.toContain("--ro-bind / /");
    expect(spec.args.join(" ")).not.toContain(`--bind ${homeDir} ${homeDir}`);
    expect(spec.args.filter((argument) => argument === nestedRoot)).toHaveLength(0);
    expect(spec.args).toContain("--share-net");
    expect(sandbox.isolation).toBe("container");
    expect(sandbox.network).toBe("allow");
  });

  it("applies read-only workspace and denied network policies", async () => {
    const rootDir = await temporaryDirectory("restricted-workspace");
    const macSandbox = new PlatformShellSandbox({
      network: "deny",
      platform: "darwin",
      sandboxExecutable: "/test/sandbox-exec",
      skipAvailabilityCheck: true,
    });
    const macSpec = macSandbox.createLaunchSpec({
      environment: {},
      shellPath: "/bin/bash",
      workspace: workspace(rootDir),
      workspaceAccess: "read-only",
    });
    const profile = macSpec.args[1] ?? "";
    const writeRule = profile.split("\n").find((line) => line.startsWith("(allow file-write*"));

    expect(profile).not.toContain("(allow network");
    expect(profile).toContain(`(subpath "${rootDir}")`);
    expect(writeRule).not.toContain(`(subpath "${rootDir}")`);
    expect(macSandbox.network).toBe("deny");
    macSandbox.close();

    const linuxSandbox = new PlatformShellSandbox({
      network: "deny",
      platform: "linux",
      sandboxExecutable: "/test/bwrap",
      skipAvailabilityCheck: true,
    });
    const linuxSpec = linuxSandbox.createLaunchSpec({
      environment: {},
      shellPath: "/bin/bash",
      workspace: workspace(rootDir),
      workspaceAccess: "read-only",
    });

    expect(linuxSpec.args).not.toContain("--share-net");
    expect(linuxSpec.args).toEqual(expect.arrayContaining(["--ro-bind", rootDir, rootDir]));
  });

  it("fails closed when the executable or platform is unavailable", async () => {
    const rootDir = await temporaryDirectory("unavailable-workspace");
    const input = {
      environment: { PATH: "" },
      shellPath: "/bin/bash",
      workspace: workspace(rootDir),
    };

    expect(() =>
      new PlatformShellSandbox({
        platform: "darwin",
        sandboxExecutable: "/definitely/missing-yiku-sandbox",
      }).createLaunchSpec(input),
    ).toThrow("executable is unavailable");
    expect(() =>
      new PlatformShellSandbox({
        platform: "darwin",
        sandboxExecutable: process.execPath,
      }).createLaunchSpec(input),
    ).toThrow("cannot start on darwin");
    expect(() => new PlatformShellSandbox({ platform: "win32" }).createLaunchSpec(input)).toThrow(
      "not supported on Windows",
    );
    expect(() => new PlatformShellSandbox({ platform: "freebsd" as never })).toThrowError(
      ShellSandboxUnavailableError,
    );
  });
});

function workspace(
  rootDir: string,
  options: {
    readonly additionalRootDirs?: readonly string[];
    readonly homeDir?: string;
  } = {},
): ShellSandboxWorkspace {
  const rootDirs = [rootDir, ...(options.additionalRootDirs ?? [])].map((path) => resolve(path));
  return {
    ...(options.homeDir !== undefined ? { homeDir: resolve(options.homeDir) } : {}),
    rootDir: resolve(rootDir),
    rootDirs,
    containsPath: (path) =>
      rootDirs.some((root) => path === root || path.startsWith(`${root}${sep}`)),
  };
}

async function temporaryDirectory(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `yiku-${name}-`));
  temporaryDirectories.push(parent);
  const directory = join(parent, name);
  await mkdir(directory);
  return resolve(directory);
}
