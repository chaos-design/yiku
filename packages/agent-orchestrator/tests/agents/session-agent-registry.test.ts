import { describe, expect, it, vi } from "vitest";
import { SessionAgentRegistry } from "../../src/agents/session-agent-registry.js";
import {
  createInitialSessionState,
  parseSessionState,
  type SessionState,
} from "../../src/session/session-state.js";

describe("SessionAgentRegistry", () => {
  it("synchronizes persisted Profiles and removes their source", async () => {
    const store = new StateStore();
    const projectProfile = {
      ...profileInput("project-reviewer"),
      configPath: "/workspace/.yiku/agents/project-reviewer.md",
      createdAt: "2026-08-08T00:00:00.000Z",
      id: "project-agent-1",
      source: "project" as const,
    };
    const profileStore = {
      list: vi.fn(async () => [projectProfile]),
      remove: vi.fn(async () => undefined),
      save: vi.fn(async () => projectProfile),
    };
    const registry = new SessionAgentRegistry({
      profileStore,
      sessionId: "session-1",
      store,
    });

    await expect(registry.syncPersistedProfiles()).resolves.toEqual([projectProfile]);
    await expect(registry.list()).resolves.toEqual([projectProfile]);
    await registry.remove(projectProfile.id);
    expect(profileStore.remove).toHaveBeenCalledWith(projectProfile);
    await expect(registry.list()).resolves.toEqual([]);
  });

  it("creates, lists, gets, and removes Session-scoped profiles", async () => {
    const store = new StateStore();
    const registry = new SessionAgentRegistry({
      idGenerator: () => "profile-1",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      sessionId: "session-1",
      store,
    });

    const created = await registry.create(profileInput("Security Reviewer"));

    expect(created).toMatchObject({
      id: "profile-1",
      name: "Security Reviewer",
      skillSnapshots: [],
      source: "session",
    });
    expect(await registry.get("profile-1")).toEqual(created);
    expect(await registry.list()).toEqual([created]);
    await registry.remove("profile-1");
    expect(await registry.list()).toEqual([]);

    const defaults = new SessionAgentRegistry({
      sessionId: "session-1",
      store: new StateStore(),
    });
    expect((await defaults.create(profileInput("Generated"))).id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("rejects duplicate names and the profile limit", async () => {
    const store = new StateStore();
    let sequence = 0;
    const registry = new SessionAgentRegistry({
      idGenerator: () => `profile-${++sequence}`,
      sessionId: "session-1",
      store,
    });
    await registry.create(profileInput("Reviewer"));
    await expect(registry.create(profileInput("reviewer"))).rejects.toMatchObject({
      code: "AGENT_PROFILE_DUPLICATE",
    });

    for (let index = 1; index < 12; index += 1) {
      await registry.create(profileInput(`Reviewer ${index}`));
    }
    await expect(registry.create(profileInput("Overflow"))).rejects.toMatchObject({
      code: "AGENT_PROFILE_LIMIT",
    });
  });

  it("tracks instances and prevents removing a running profile", async () => {
    const store = new StateStore();
    const ids = ["profile-1", "agent-1"];
    const registry = new SessionAgentRegistry({
      idGenerator: () => ids.shift() ?? "unexpected",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      sessionId: "session-1",
      store,
    });
    const profile = await registry.create(profileInput("Reviewer"));
    await expect(registry.startInstance(profile.id, "   ")).rejects.toThrow(
      "Task ID must be non-empty",
    );
    const instance = await registry.startInstance(profile.id, "task-1");

    expect(instance).toMatchObject({
      agentId: "agent-1",
      profileId: "profile-1",
      status: "running",
    });
    await expect(registry.remove(profile.id)).rejects.toMatchObject({
      code: "AGENT_PROFILE_IN_USE",
    });

    const completed = await registry.finishInstance(instance.agentId, "succeeded");
    expect(completed.status).toBe("succeeded");
    expect(await registry.instances(profile.id)).toEqual([completed]);
    await expect(registry.remove(profile.id)).resolves.toBeUndefined();
  });

  it("reports missing records and preserves failed instance errors", async () => {
    const store = new StateStore();
    const ids = ["profile-1", "agent-1"];
    const registry = new SessionAgentRegistry({
      idGenerator: () => ids.shift() ?? "unexpected",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      sessionId: "session-1",
      store,
    });

    expect(await registry.get("missing")).toBeUndefined();
    await expect(registry.remove("missing")).rejects.toMatchObject({
      code: "AGENT_PROFILE_NOT_FOUND",
    });
    await expect(registry.startInstance("missing", "task-1")).rejects.toMatchObject({
      code: "AGENT_PROFILE_NOT_FOUND",
    });
    await expect(registry.finishInstance("missing", "failed")).rejects.toMatchObject({
      code: "AGENT_INSTANCE_NOT_FOUND",
    });

    const profile = await registry.create(profileInput("Reviewer"));
    const instance = await registry.startInstance(profile.id, "task-1");
    const stillRunning = await registry.startInstance(profile.id, "task-2");
    const failed = await registry.finishInstance(instance.agentId, "failed", " provider failed ");
    expect(failed).toMatchObject({
      error: "provider failed",
      status: "failed",
    });
    expect(await registry.instances()).toEqual([failed, stillRunning]);
  });
});

class StateStore {
  private state = createInitialSessionState({
    agentKey: "code",
    configFingerprint: "fingerprint",
    modelKey: "code",
    now: "2026-08-08T00:00:00.000Z",
    sessionId: "session-1",
    workspaceDir: "/workspace",
  });

  public async load(): Promise<SessionState> {
    return this.state;
  }

  public async update(
    _sessionId: string,
    expectedRevision: number,
    update: (state: SessionState) => SessionState,
  ): Promise<SessionState> {
    if (this.state.revision !== expectedRevision) {
      throw new Error("revision conflict");
    }
    this.state = parseSessionState({
      ...update(this.state),
      revision: expectedRevision + 1,
      updatedAt: "2026-08-08T00:00:01.000Z",
    });
    return this.state;
  }
}

function profileInput(name: string) {
  return {
    accessMode: "read-only" as const,
    agentType: "code",
    createdBy: "user" as const,
    deliverable: "A focused review.",
    description: "Review code.",
    instructions: "Review behavior.",
    invocationMode: "manual" as const,
    modelKey: "code",
    name,
    purpose: "code-review" as const,
    role: "Reviewer",
    scopes: ["."],
    skillSnapshots: [],
  };
}
