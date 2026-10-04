import type { ShellIsolationLevel, ShellNetworkPolicy } from "@yiku/sandbox";
import type { PermissionAssessment, PermissionRisk } from "./types.js";

export type { ShellIsolationLevel, ShellNetworkPolicy } from "@yiku/sandbox";

export interface ShellPolicyWorkspace {
  readonly homeDir?: string | undefined;
  readonly rootDir: string;
  readonly rootDirs: readonly string[];
  readonly workspaceId: string;
  assertPath(path: string): string;
  containsPath(path: string): boolean;
  resolvePath(path: string, fromDir?: string): string;
}

export interface ShellPolicyContext {
  readonly currentCwd: string;
  readonly workspace: ShellPolicyWorkspace;
}

export interface ShellCommandAssessment {
  readonly capabilities: readonly string[];
  readonly decision: PermissionAssessment;
  readonly normalizedAction: string;
  readonly policyId: string;
  readonly reason: string;
  readonly risk: PermissionRisk;
}

export type BashCommandRiskAssessment = ShellCommandAssessment;

export interface ShellPolicyOptions {
  readonly allowedNetworkHosts?: readonly string[] | undefined;
  readonly isolation?: ShellIsolationLevel | undefined;
  readonly network?: ShellNetworkPolicy | undefined;
}

export interface ParsedShellCommand {
  readonly complex: boolean;
  readonly dynamic: boolean;
  readonly hasComplexOperator: boolean;
  readonly outputRedirectionTargets: readonly string[];
  readonly redirectionTargets: readonly string[];
  readonly segments: readonly (readonly string[])[];
  readonly valid: boolean;
}

export interface ShellCommandDetails {
  readonly executable: string;
  readonly words: readonly string[];
}

export function createShellAssessment(
  policyId: string,
  normalizedAction: string,
  decision: PermissionAssessment,
  risk: PermissionRisk,
  capabilities: readonly string[],
  reason: string,
): ShellCommandAssessment {
  return {
    capabilities: Object.freeze([...capabilities]),
    decision,
    normalizedAction,
    policyId,
    reason,
    risk,
  };
}
