import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { ShellSandboxUnavailableError } from "./errors.js";
import type {
  PlatformShellSandboxOptions,
  ShellIsolationLevel,
  ShellNetworkPolicy,
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
  ShellSandboxPlatform,
  ShellSandboxWorkspaceAccess,
} from "./types.js";

export class PlatformShellSandbox implements ShellProcessSandbox {
  public readonly isolation: ShellIsolationLevel;
  public readonly network: ShellNetworkPolicy;
  private readonly options: PlatformShellSandboxOptions;
  private readonly platform: ShellSandboxPlatform;
  private ownsTempDirectory = false;
  private tempDirectory: string | undefined;

  public constructor(options: PlatformShellSandboxOptions = {}) {
    this.options = options;
    this.platform = supportedPlatform(options.platform ?? process.platform);
    this.isolation = this.platform === "linux" ? "container" : "sandbox";
    this.network = options.network ?? "allow";
  }

  public createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    if (this.platform === "darwin") {
      return this.createDarwinLaunchSpec(input);
    }
    if (this.platform === "linux") {
      return this.createLinuxLaunchSpec(input);
    }
    throw new ShellSandboxUnavailableError(
      this.platform,
      "Shell sandboxing is not supported on Windows until a Job Object and ACL sandbox is available.",
    );
  }

  public close(): void {
    if (this.tempDirectory === undefined) {
      return;
    }
    if (this.ownsTempDirectory) {
      rmSync(this.tempDirectory, { force: true, recursive: true });
    }
    this.tempDirectory = undefined;
    this.ownsTempDirectory = false;
  }

  private createDarwinLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    const sandboxExecutable = this.options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
    if (this.options.skipAvailabilityCheck !== true) {
      assertExecutable(sandboxExecutable, this.platform);
      assertDarwinSandboxUsable(sandboxExecutable);
    }
    const tempDirectory = this.ensureTempDirectory();
    const homeDirectory = join(tempDirectory, "home");
    const processTempDirectory = join(tempDirectory, "tmp");
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(processTempDirectory, { recursive: true });
    const runtimeReadPaths = runtimePaths(input, this.options.runtimeReadPaths, this.platform);
    const profile = darwinProfile({
      network: this.network,
      rootDirs: input.workspace.rootDirs,
      runtimeReadPaths,
      tempDirectory,
      workspaceAccess: input.workspaceAccess ?? "read-write",
    });

    return {
      args: ["-p", profile, input.shellPath],
      command: sandboxExecutable,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: sandboxEnvironment(
        input.environment,
        input.workspace.homeDir ?? homeDirectory,
        homeDirectory,
        processTempDirectory,
      ),
    };
  }

  private createLinuxLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    const sandboxExecutable =
      this.options.sandboxExecutable ?? findFirstExecutable(["/usr/bin/bwrap", "/bin/bwrap"]);
    if (sandboxExecutable === undefined) {
      throw new ShellSandboxUnavailableError(
        this.platform,
        "Linux shell sandboxing requires bubblewrap (bwrap).",
      );
    }
    if (this.options.skipAvailabilityCheck !== true) {
      assertExecutable(sandboxExecutable, this.platform);
      assertLinuxSandboxUsable(sandboxExecutable);
    }

    const runtimeReadPaths = runtimePaths(
      input,
      this.options.runtimeReadPaths,
      this.platform,
    ).filter((path) => !input.workspace.containsPath(path));
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      ...(this.network === "deny" ? [] : ["--share-net"]),
      "--cap-drop",
      "ALL",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];
    const createdDirectories = new Set<string>(["/", "/dev", "/proc", "/tmp"]);

    for (const path of runtimeReadPaths) {
      appendParentDirectories(args, path, createdDirectories);
      args.push("--ro-bind", path, path);
    }
    for (const rootDir of collapseNestedPaths(input.workspace.rootDirs)) {
      appendParentDirectories(args, rootDir, createdDirectories);
      args.push(input.workspaceAccess === "read-only" ? "--ro-bind" : "--bind", rootDir, rootDir);
    }
    args.push("--dir", "/tmp/yiku-home");
    args.push("--setenv", "HOME", input.workspace.homeDir ?? "/tmp/yiku-home");
    args.push("--setenv", "TMPDIR", "/tmp");
    args.push("--setenv", "XDG_CACHE_HOME", "/tmp/yiku-home/.cache");
    args.push("--chdir", input.cwd ?? input.workspace.rootDir);
    args.push("--", input.shellPath);

    return {
      args,
      command: sandboxExecutable,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: { ...input.environment },
    };
  }

  private ensureTempDirectory(): string {
    if (this.tempDirectory !== undefined) {
      return this.tempDirectory;
    }
    this.ownsTempDirectory = this.options.tempDirectory === undefined;
    const requestedDirectory =
      this.options.tempDirectory ?? mkdtempSync(join(tmpdir(), "yiku-shell-sandbox-"));
    mkdirSync(requestedDirectory, { recursive: true });
    this.tempDirectory = realpathSync.native(requestedDirectory);
    return this.tempDirectory;
  }
}

function supportedPlatform(platform: NodeJS.Platform): ShellSandboxPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw new ShellSandboxUnavailableError(
    platform,
    `Shell sandboxing does not support platform ${platform}.`,
  );
}

function assertExecutable(path: string, platform: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new ShellSandboxUnavailableError(
      platform,
      `Shell sandbox executable is unavailable: ${path}.`,
    );
  }
}

function findFirstExecutable(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  return undefined;
}

function assertDarwinSandboxUsable(executable: string): void {
  const result = spawnSync(executable, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 3_000,
  });
  assertProbeSucceeded(result, "darwin");
}

function assertLinuxSandboxUsable(executable: string): void {
  const runtimePaths = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter((path) =>
    existsSync(path),
  );
  const runtimeArgs = runtimePaths.flatMap((path) => ["--ro-bind", path, path]);
  const trueExecutable = existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
  const result = spawnSync(
    executable,
    [
      "--die-with-parent",
      "--unshare-all",
      ...runtimeArgs,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      trueExecutable,
    ],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 3_000,
    },
  );
  assertProbeSucceeded(result, "linux");
}

function assertProbeSucceeded(
  result: ReturnType<typeof spawnSync>,
  platform: ShellSandboxPlatform,
): void {
  if (result.status === 0 && result.error === undefined) {
    return;
  }
  const detail = String(result.stderr || result.error?.message || "probe failed")
    .trim()
    .slice(0, 500);
  throw new ShellSandboxUnavailableError(
    platform,
    `Shell sandbox cannot start on ${platform}: ${detail}.`,
  );
}

function runtimePaths(
  input: ShellSandboxLaunchInput,
  configuredPaths: readonly string[] | undefined,
  platform: ShellSandboxPlatform,
): readonly string[] {
  const systemPaths =
    platform === "darwin"
      ? [
          "/System",
          "/usr",
          "/bin",
          "/sbin",
          "/Library/Apple",
          "/private/etc",
          "/private/var/db/dyld",
          "/dev",
        ]
      : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/nix/store"];
  const pathEntries = input.environment.PATH?.split(delimiter) ?? [];
  const paths = new Set<string>();

  for (const candidate of [...systemPaths, input.shellPath, ...(configuredPaths ?? [])]) {
    for (const identity of existingPathIdentities(candidate)) {
      if (!isFilesystemRoot(identity)) {
        paths.add(identity);
      }
    }
  }
  for (const candidate of pathEntries) {
    for (const identity of existingPathIdentities(candidate)) {
      if (
        !isFilesystemRoot(identity) &&
        !input.workspace.containsPath(identity) &&
        !input.workspace.rootDir.startsWith(`${identity}/`)
      ) {
        paths.add(identity);
      }
    }
  }
  for (const rootDir of input.workspace.rootDirs) {
    paths.add(rootDir);
  }

  return collapseNestedPaths([...paths]);
}

function existingPathIdentities(path: string): readonly string[] {
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    return [];
  }
  const lexicalPath = resolve(path);
  try {
    return [...new Set([lexicalPath, realpathSync.native(path)])];
  } catch {
    return [lexicalPath];
  }
}

function isFilesystemRoot(path: string): boolean {
  return parsePath(path).root === path;
}

function collapseNestedPaths(paths: readonly string[]): readonly string[] {
  const sorted = [...paths].sort((left, right) => left.length - right.length);
  return sorted.filter(
    (path, index) =>
      !sorted.slice(0, index).some((parent) => path === parent || path.startsWith(`${parent}/`)),
  );
}

function darwinProfile(input: {
  readonly network: ShellNetworkPolicy;
  readonly rootDirs: readonly string[];
  readonly runtimeReadPaths: readonly string[];
  readonly tempDirectory: string;
  readonly workspaceAccess: ShellSandboxWorkspaceAccess;
}): string {
  const readFilters = profileFilters([
    ...input.runtimeReadPaths,
    ...input.rootDirs,
    input.tempDirectory,
  ]);
  const writeFilters = profileFilters([
    ...(input.workspaceAccess === "read-write" ? input.rootDirs : []),
    input.tempDirectory,
  ]);
  const writableDevices = ["/dev/null", "/dev/random", "/dev/urandom", "/dev/zero"]
    .map((path) => `(literal "${escapeProfilePath(path)}")`)
    .join(" ");

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm*)",
    ...(input.network === "deny" ? [] : ["(allow network*)"]),
    "(allow file-read-metadata)",
    `(allow file-read* ${readFilters})`,
    `(allow file-write* ${writeFilters} ${writableDevices})`,
  ].join("\n");
}

function profileFilters(paths: readonly string[]): string {
  return [...new Set(paths)].map((path) => `(subpath "${escapeProfilePath(path)}")`).join(" ");
}

function escapeProfilePath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sandboxEnvironment(
  input: Readonly<NodeJS.ProcessEnv>,
  homeDirectory: string,
  sandboxHomeDirectory: string,
  processTempDirectory: string,
): Readonly<NodeJS.ProcessEnv> {
  return {
    ...input,
    HOME: homeDirectory,
    TMPDIR: processTempDirectory,
    XDG_CACHE_HOME: join(sandboxHomeDirectory, ".cache"),
  };
}

function appendParentDirectories(
  args: string[],
  path: string,
  createdDirectories: Set<string>,
): void {
  let current = dirname(path);
  const parents: string[] = [];
  const root = parsePath(path).root;

  while (current !== root && !createdDirectories.has(current)) {
    parents.push(current);
    current = dirname(current);
  }
  for (const parent of parents.reverse()) {
    args.push("--dir", parent);
    createdDirectories.add(parent);
  }
}
