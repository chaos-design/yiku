import type { spawn } from "node:child_process";
import type { AgentArtifactRef, VerificationCommand } from "@yiku/evals";
import type { ShellProcessSandbox } from "@yiku/sandbox";
import type { WorkspaceContext } from "../tools/common/workspace-context.js";

export interface CodeSnapshotEntry {
  readonly digest: string;
  readonly external: boolean;
  readonly mode: number;
  readonly path: string;
  readonly sizeBytes: number;
  readonly type: "file" | "symlink";
}

export interface CodeWorkspaceSnapshot {
  readonly digest: string;
  readonly entries: readonly CodeSnapshotEntry[];
  readonly totalBytes: number;
  readonly version: 1;
}

export interface CodeArtifactScope {
  readonly allowedPaths?: readonly string[] | undefined;
  readonly deniedPaths?: readonly string[] | undefined;
}

export interface CodeArtifactCollectorOptions extends CodeArtifactScope {
  readonly exclude?: readonly string[] | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly workspace: WorkspaceContext;
}

export interface VerificationCommandResult {
  readonly artifact: AgentArtifactRef;
  readonly command: VerificationCommand;
  readonly durationMs: number;
  readonly exitCode?: number | undefined;
  readonly outputDigest: string;
  readonly signal?: NodeJS.Signals | undefined;
  readonly stderrHead: string;
  readonly stderrTail: string;
  readonly stdoutHead: string;
  readonly stdoutTail: string;
  readonly timedOut: boolean;
}

export interface VerificationCommandRunnerOptions {
  readonly isolatedWorkspace?: boolean | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly runtimeReadPaths?: readonly string[] | undefined;
  readonly sandbox?: ShellProcessSandbox | undefined;
  readonly spawnProcess?: typeof spawn | undefined;
  readonly workspace: WorkspaceContext;
}
