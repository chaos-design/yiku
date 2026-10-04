import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialSessionState } from "../../src/session/session-state.js";
import { SessionStore } from "../../src/session/session-store.js";
import { SessionTaskStore } from "../../src/tasks/task-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SessionTaskStore", () => {
  it("persists task replacement and durable progress in Session State", async () => {
    const directory = await temporaryDirectory();
    const sessions = new SessionStore({
      heartbeatIntervalMs: 0,
      sessionsDir: directory,
    });
    await sessions.create(
      createInitialSessionState({
        agentKey: "code",
        configFingerprint: "config-v1",
        modelKey: "default",
        now: "2026-08-01T00:00:00.000Z",
        sessionId: "session-1",
        workspaceDir: "/workspace",
      }),
    );
    const tasks = new SessionTaskStore({
      sessionId: "session-1",
      store: sessions,
    });

    await tasks.replace([
      {
        id: "task-1",
        revision: 1,
        status: "in_progress",
        subject: "Run tests",
      },
    ]);

    await expect(tasks.list()).resolves.toEqual([
      {
        id: "task-1",
        revision: 1,
        status: "in_progress",
        subject: "Run tests",
      },
    ]);
    await expect(sessions.load("session-1")).resolves.toMatchObject({
      budget: {
        progressRevision: 1,
      },
    });
    await sessions.close();
  });

  it("does not advance progress for identical replacements", async () => {
    const directory = await temporaryDirectory();
    const sessions = new SessionStore({
      heartbeatIntervalMs: 0,
      sessionsDir: directory,
    });
    const initial = createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config-v1",
      modelKey: "default",
      now: "2026-08-01T00:00:00.000Z",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });
    await sessions.create(initial);
    const tasks = new SessionTaskStore({
      sessionId: "session-1",
      store: sessions,
    });

    await tasks.replace([]);
    expect((await sessions.load("session-1")).budget.progressRevision).toBe(0);
    await sessions.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-task-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
