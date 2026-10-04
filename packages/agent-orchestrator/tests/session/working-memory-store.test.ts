import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialSessionState } from "../../src/session/session-state.js";
import { SessionStore } from "../../src/session/session-store.js";
import { SessionWorkingMemoryStore } from "../../src/session/working-memory-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SessionWorkingMemoryStore", () => {
  it("persists isolated Working Memory through Session reloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-working-memory-"));
    directories.push(directory);
    const sessionStore = new SessionStore({
      heartbeatIntervalMs: 0,
      sessionsDir: directory,
    });
    const state = await sessionStore.create(
      createInitialSessionState({
        agentKey: "code",
        configFingerprint: "config",
        modelKey: "model",
        now: "2026-08-07T00:00:00.000Z",
        sessionId: "session-1",
        workspaceDir: "/workspace",
      }),
    );
    const workingStore = new SessionWorkingMemoryStore({
      sessionId: state.sessionId,
      store: sessionStore,
    });
    const record = {
      content: "Current task",
      createdAt: "2026-08-07T00:00:00.000Z",
      id: "working-1",
      sessionId: state.sessionId,
      source: "task" as const,
      status: "active" as const,
      updatedAt: "2026-08-07T00:00:00.000Z",
    };

    await workingStore.replace(state.sessionId, [record]);

    expect(await workingStore.list(state.sessionId)).toEqual([record]);
    expect((await sessionStore.load(state.sessionId)).workingMemories).toEqual([record]);
    await expect(workingStore.list("another-session")).rejects.toThrow("another Session");
    await sessionStore.close();
  });
});
