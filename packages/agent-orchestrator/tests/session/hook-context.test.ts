import { resolve } from "node:path";
import { YikuPaths } from "@yiku/config";
import { describe, expect, it } from "vitest";
import { resolveAgentHookContext } from "../../src/session/hook-context.js";

describe("resolveAgentHookContext", () => {
  it("resolves explicit workspace, session, transcript, and permission mode", () => {
    const context = resolveAgentHookContext({
      cwd: "/workspace",
      hooks: {
        engine: {} as never,
        permissionMode: "plan",
      },
      sessionId: "session/unsafe",
      sessionsDir: "/sessions",
    });

    expect(context).toEqual({
      permissionMode: "plan",
      sessionId: "session-unsafe",
      sessionsDir: "/sessions",
      transcriptFilePath: "/sessions/session-unsafe.transcript.jsonl",
      workspaceDir: "/workspace",
    });
  });

  it("uses the environment Workspace and Home Session storage", () => {
    const context = resolveAgentHookContext({
      env: {
        YIKU_WORKSPACE_DIR: "/env/workspace",
      },
      homeDir: "/home/user",
      sessionId: "session-1",
    });

    expect(context.workspaceDir).toBe("/env/workspace");
    expect(context.sessionsDir).toBe(
      new YikuPaths({
        homeDir: "/home/user",
        workspaceDir: "/env/workspace",
      }).sessionsDir,
    );
  });

  it("generates a safe identifier when none is supplied", () => {
    const context = resolveAgentHookContext({ cwd: "." });

    expect(context.workspaceDir).toBe(resolve("."));
    expect(context.sessionId).toMatch(/^[a-zA-Z0-9._-]+$/u);
    expect(context.transcriptFilePath).toContain(context.sessionId);
  });
});
