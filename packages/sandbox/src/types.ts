export type ShellIsolationLevel = "container" | "host-policy" | "sandbox";
export type ShellNetworkPolicy = "allow" | "allowlist" | "ask" | "deny";
export type ShellSandboxPlatform = "darwin" | "linux" | "win32";
export type ShellSandboxWorkspaceAccess = "read-only" | "read-write";

export interface ShellSandboxWorkspace {
  readonly homeDir?: string | undefined;
  readonly rootDir: string;
  readonly rootDirs: readonly string[];
  containsPath(path: string): boolean;
}

export interface ShellSandboxLaunchInput {
  readonly cwd?: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly shellPath: string;
  readonly workspace: ShellSandboxWorkspace;
  readonly workspaceAccess?: ShellSandboxWorkspaceAccess | undefined;
}

export interface ShellSandboxLaunchSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export interface ShellProcessSandbox {
  readonly isolation: ShellIsolationLevel;
  readonly network: ShellNetworkPolicy;
  close(): void;
  createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec;
}

export interface PlatformShellSandboxOptions {
  readonly network?: ShellNetworkPolicy | undefined;
  readonly platform?: ShellSandboxPlatform | undefined;
  readonly runtimeReadPaths?: readonly string[] | undefined;
  readonly sandboxExecutable?: string | undefined;
  readonly skipAvailabilityCheck?: boolean | undefined;
  readonly tempDirectory?: string | undefined;
}
