import type {
  ShellNetworkPolicy,
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
} from "./types.js";

export class HostPolicyShellSandbox implements ShellProcessSandbox {
  public readonly isolation = "host-policy" as const;
  public readonly network: ShellNetworkPolicy;

  public constructor(network: ShellNetworkPolicy = "allow") {
    this.network = network;
  }

  public close(): void {}

  public createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    return {
      args: ["--noprofile", "--norc"],
      command: input.shellPath,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: input.environment,
    };
  }
}
