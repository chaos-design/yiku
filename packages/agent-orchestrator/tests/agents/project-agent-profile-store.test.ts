import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProjectAgentProfileInput,
  ProjectAgentProfileStore,
  UserAgentProfileStore,
} from "../../src/agents/project-agent-profile-store.js";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ProjectAgentProfileStore", () => {
  it("atomically saves, loads, and removes project Agent Profiles", async () => {
    const workspace = await temporaryDirectory();
    const store = await createStore(workspace);
    const profile = await store.save(profileInput());

    expect(profile).toMatchObject({
      configPath: expect.stringContaining(".yiku/agents/security-reviewer.md"),
      id: expect.stringMatching(/^project-agent-/u),
      source: "project",
    });
    expect(await readFile(profile.configPath as string, "utf8")).toContain(
      "invocationMode: proactive",
    );
    await expect((await createStore(workspace)).list()).resolves.toEqual([profile]);
    await expect(store.save(profileInput())).rejects.toThrow("already exists");
    await store.remove(profile);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects unsafe names, invalid files, and symbolic-link storage", async () => {
    const workspace = await temporaryDirectory();
    const store = await createStore(workspace);
    await expect(
      store.save({
        ...profileInput(),
        name: "../escape",
      }),
    ).rejects.toThrow("lowercase kebab-case");

    const agentsDir = join(workspace, ".yiku", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "invalid.md"), "---\nname: invalid\n---\n");
    await expect(store.list()).rejects.toThrow("Invalid Agent Profile");

    const linkedWorkspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(linkedWorkspace, ".yiku"));
    await expect((await createStore(linkedWorkspace)).save(profileInput())).rejects.toThrow(
      "symbolic links",
    );
  });

  it("loads but does not modify Profiles in read-only mode", async () => {
    const workspace = await temporaryDirectory();
    const writable = await createStore(workspace);
    const profile = await writable.save(profileInput());
    const readOnly = await createStore(workspace, false);

    await expect(readOnly.list()).resolves.toEqual([profile]);
    await expect(readOnly.save(profileInput())).rejects.toThrow("read-only mode");
    await expect(readOnly.remove(profile)).rejects.toThrow("read-only mode");
  });

  it("persists user Agent Profiles under the global Yiku directory", async () => {
    const homeDir = await temporaryDirectory();
    const skillRuntime = await createSkillRuntime();
    const store = new UserAgentProfileStore({
      homeDir,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      skillRuntime,
    });

    const profile = await store.save(profileInput());

    expect(profile).toMatchObject({
      configPath: expect.stringMatching(/\.yiku\/agents\/security-reviewer\.md$/u),
      id: expect.stringMatching(/^user-agent-/u),
      source: "user",
    });
    await expect(store.list()).resolves.toEqual([profile]);
  });
});

async function createStore(
  workspaceDir: string,
  writable = true,
): Promise<ProjectAgentProfileStore> {
  const skillRuntime = await createSkillRuntime();
  return new ProjectAgentProfileStore({
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    skillRuntime,
    writable,
    workspaceDir,
  });
}

async function createSkillRuntime(): Promise<SkillRuntime> {
  const skillRuntime = new SkillRuntime({
    discovery: async () => ({
      diagnostics: [],
      shadowed: [],
      skills: [],
    }),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  await skillRuntime.discover();
  return skillRuntime;
}

function profileInput(): ProjectAgentProfileInput {
  return {
    accessMode: "read-only",
    agentType: "code",
    createdBy: "user",
    deliverable: "A prioritized review.",
    description: "Review authentication security.",
    instructions: "Report verifiable issues.",
    invocationMode: "proactive",
    modelKey: "code",
    name: "security-reviewer",
    purpose: "code-review",
    role: "Security reviewer.",
    scopes: ["packages/agent-orchestrator"],
    skillSnapshots: [],
    triggerInstructions: "后端逻辑完成后运行",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-agent-profile-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
