import type {
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
} from "@yiku/sandbox";

export const HOST_SHELL_SANDBOX: ShellProcessSandbox = Object.freeze({
  close: () => undefined,
  createLaunchSpec: (input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec => ({
    args: [],
    command: input.shellPath,
    cwd: input.workspace.rootDir,
    environment: input.environment,
  }),
  isolation: "host-policy",
  network: "ask",
});
