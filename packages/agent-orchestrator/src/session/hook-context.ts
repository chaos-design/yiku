import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { YikuPaths } from "@yiku/config";
import type { HookPermissionMode } from "@yiku/hooks";
import type { AgentSessionOptions } from "./types.js";

export interface AgentHookContext {
  readonly permissionMode: HookPermissionMode;
  readonly sessionId: string;
  readonly sessionsDir: string;
  readonly transcriptFilePath: string;
  readonly workspaceDir: string;
}

export function resolveAgentHookContext(options: AgentSessionOptions): AgentHookContext {
  const workspaceDir = resolve(
    options.cwd ??
      options.env?.YIKU_WORKSPACE_DIR ??
      process.env.YIKU_WORKSPACE_DIR ??
      process.cwd(),
  );
  const sessionId = sanitizeSessionId(options.sessionId?.trim() || randomUUID());
  const configuredSessionsDir =
    options.sessionsDir ??
    options.runtimeStorage?.sessionsDir ??
    new YikuPaths({
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      workspaceDir,
    }).sessionsDir;
  const sessionsDir = resolve(workspaceDir, configuredSessionsDir);

  return Object.freeze({
    permissionMode: options.hooks?.permissionMode ?? "default",
    sessionId,
    sessionsDir,
    transcriptFilePath: join(sessionsDir, `${sessionId}.transcript.jsonl`),
    workspaceDir,
  });
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, "-");
}
