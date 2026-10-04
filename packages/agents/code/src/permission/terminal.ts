import {
  assessCommandActions,
  assessHostBoundary,
  extractNetworkHosts,
  isNetworkCommand,
  isRemoteShellPipeline,
  isSafeCommand,
  isSafeDiscardOnlyCommand,
  isSafeWorkspaceWrite,
} from "./shell-command-policy.js";
import { parseShellCommand } from "./shell-parser.js";
import { assessPathBoundary } from "./shell-path-policy.js";
import {
  createShellAssessment as assessment,
  type BashCommandRiskAssessment,
  type ShellCommandAssessment,
  type ShellIsolationLevel,
  type ShellNetworkPolicy,
  type ShellPolicyContext,
  type ShellPolicyOptions,
} from "./terminal-types.js";

export type {
  BashCommandRiskAssessment,
  ShellCommandAssessment,
  ShellIsolationLevel,
  ShellNetworkPolicy,
  ShellPolicyContext,
  ShellPolicyOptions,
  ShellPolicyWorkspace,
} from "./terminal-types.js";

const PROCESS_CAPABILITY = Object.freeze(["process.execute"]);

export class ShellPolicy {
  public readonly allowedNetworkHosts: ReadonlySet<string>;
  public readonly isolation: ShellIsolationLevel;
  public readonly network: ShellNetworkPolicy;

  public constructor(options: ShellPolicyOptions = {}) {
    this.isolation = options.isolation ?? "host-policy";
    this.network = options.network ?? "allow";
    this.allowedNetworkHosts = new Set(
      (options.allowedNetworkHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    );
  }

  public classify(command: string, context?: ShellPolicyContext): ShellCommandAssessment {
    const normalizedCommand = command.trim();
    const parsed = parseShellCommand(normalizedCommand);

    if (!normalizedCommand || !parsed.valid) {
      return assessment(
        "shell-opaque",
        "execute opaque shell syntax",
        "ask",
        "high",
        ["process.execute", "shell.opaque"],
        "contains shell syntax that cannot be classified safely",
      );
    }

    const hostAssessment = assessHostBoundary(parsed.segments);
    if (hostAssessment !== undefined) {
      return hostAssessment;
    }

    if (isRemoteShellPipeline(parsed)) {
      return assessment(
        "remote-shell-pipe",
        "execute remote content in a shell",
        "deny",
        "high",
        ["process.execute", "network.connect", "shell.opaque"],
        "pipes remote content directly into a shell",
      );
    }

    const pathAssessment = context === undefined ? undefined : assessPathBoundary(parsed, context);
    if (pathAssessment !== undefined) {
      return pathAssessment;
    }

    const commandAssessment = assessCommandActions(parsed.segments);
    if (commandAssessment !== undefined) {
      return commandAssessment;
    }

    if (parsed.segments.some((segment) => isNetworkCommand(segment))) {
      return this.networkAssessment(normalizedCommand);
    }

    if (isSafeWorkspaceWrite(parsed)) {
      return assessment(
        "workspace-file-write",
        "create or update workspace files",
        "allow",
        "medium",
        ["process.execute", "workspace.write"],
        "uses a classified workspace file-write command",
      );
    }

    if (isSafeDiscardOnlyCommand(parsed)) {
      return assessment(
        "known-low-risk-command",
        "execute classified workspace command",
        "allow",
        "low",
        PROCESS_CAPABILITY,
        "matches the low-risk shell command allowlist",
      );
    }

    if (parsed.complex) {
      return assessment(
        "complex-shell",
        "execute complex shell command",
        "ask",
        "high",
        ["process.execute", "shell.opaque"],
        "uses a pipeline, redirection, substitution, or compound shell expression",
      );
    }

    if (parsed.segments.every((segment) => isSafeCommand(segment))) {
      return assessment(
        "known-low-risk-command",
        "execute classified workspace command",
        "allow",
        "low",
        PROCESS_CAPABILITY,
        "matches the low-risk shell command allowlist",
      );
    }

    return assessment(
      "unclassified-shell-command",
      "execute unclassified shell command",
      "ask",
      "medium",
      ["process.execute", "workspace.write"],
      "is not proven read-only or limited to an approved build command",
    );
  }

  private networkAssessment(command: string): ShellCommandAssessment {
    if (this.network === "allow") {
      return assessment(
        "shell-network-allowed",
        "use Shell network channel",
        "allow",
        "medium",
        ["process.execute", "network.connect"],
        "Shell network access is enabled by policy",
      );
    }

    if (this.network === "deny") {
      return assessment(
        "shell-network-denied",
        "use Shell network channel",
        "deny",
        "high",
        ["process.execute", "network.connect"],
        "Shell network access is disabled by policy",
      );
    }

    if (this.network === "allowlist") {
      const hosts = extractNetworkHosts(command);
      if (
        hosts.length === 0 ||
        hosts.some((host) => !this.allowedNetworkHosts.has(host.toLowerCase()))
      ) {
        return assessment(
          "shell-network-host-denied",
          "connect to non-allowlisted network host",
          "deny",
          "high",
          ["process.execute", "network.connect"],
          "Shell network target is not in the configured host allowlist",
        );
      }
      return assessment(
        "shell-network-allowlist",
        "connect to allowlisted network host",
        "allow",
        "medium",
        ["process.execute", "network.connect"],
        "Shell network targets match the configured host allowlist",
      );
    }

    return assessment(
      "shell-network-approval",
      "use Shell network channel",
      "ask",
      "high",
      ["process.execute", "network.connect"],
      "uses the Shell network channel",
    );
  }
}

export function assessBashCommandRisk(command: string): BashCommandRiskAssessment | undefined {
  if (!command.trim()) {
    return undefined;
  }
  const result = new ShellPolicy().classify(command);
  return result.decision === "allow" ? undefined : result;
}
