import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfileGenerator, SkillGenerator } from "@yiku/agent-orchestrator";
import { describe, expect, it, vi } from "vitest";
import { CliAgentSession } from "../src/agent-session.js";

describe("CliAgentSession Agent management", () => {
  it("creates, resumes, lists, shows, and removes Session-scoped Profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-cli-agents-"));
    const cwd = join(root, "workspace");
    const homeDir = join(root, "home");
    await mkdir(cwd, { recursive: true });
    const request = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", request);
    const agentProfileGenerator: AgentProfileGenerator = {
      generate: vi.fn(async () => ({
        accessMode: "read-only",
        agentType: "code",
        deliverable: "A prioritized security review.",
        description: "Review authentication security.",
        instructions: "Review authentication and authorization.",
        invocationMode: "proactive",
        modelKey: "gpt-test",
        name: "security-reviewer",
        purpose: "code-review",
        role: "Security reviewer",
        scopes: ["."],
        skillNames: [],
      })),
    };
    const session = new CliAgentSession({
      agentProfileGenerator,
      cwd,
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
        YIKU_ATOMIC_STUDIO_URL: "http://127.0.0.1:4318",
      },
      homeDir,
      sessionId: "agent-management",
    });

    try {
      const created = await session.createAgent("Review authentication", vi.fn());
      expect(created).toMatchObject({
        accessMode: "read-only",
        agentType: "code",
        name: "security-reviewer",
        source: "user",
      });
      expect(created.configPath?.endsWith(join(".yiku", "agents", "security-reviewer.md"))).toBe(
        true,
      );
      const delivered = request.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body)),
      ) as Array<{
        readonly event: { readonly atom: { readonly key: string } };
        readonly run?: { readonly kind?: string };
      }>;
      expect(delivered.some((input) => input.run?.kind === "control")).toBe(true);
      expect(delivered.some((input) => input.event.atom.key === "agent.profile")).toBe(true);
      await expect(session.listAgents()).resolves.toEqual([created]);
      await expect(session.showAgent(created.id)).resolves.toEqual(created);
      await session.close("other");

      const resumed = new CliAgentSession({
        agentProfileGenerator,
        cwd,
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        homeDir,
        resumeSessionId: "agent-management",
      });
      try {
        await expect(resumed.listAgents()).resolves.toEqual([
          expect.objectContaining({ id: created.id, name: "security-reviewer" }),
        ]);
        await resumed.removeAgent(created.id);
        await expect(resumed.listAgents()).resolves.toEqual([]);
      } finally {
        await resumed.close("other");
      }
    } finally {
      await session.close("other").catch(() => undefined);
      vi.unstubAllGlobals();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("creates a user Skill and refreshes the current Session catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-cli-skills-"));
    const cwd = join(root, "workspace");
    const homeDir = join(root, "home");
    const installSource = join(root, "install-source");
    await mkdir(cwd, { recursive: true });
    await mkdir(installSource, { recursive: true });
    await writeFile(
      join(installSource, "SKILL.md"),
      [
        "---",
        "name: installed-review",
        "description: Review installed changes. Invoke for installed reviews.",
        "---",
        "",
        "Review changes from the installed Skill.",
        "",
      ].join("\n"),
    );
    const skillGenerator: SkillGenerator = {
      generate: vi.fn(async () => ({
        description: "Reviews code. Invoke when code changes need review.",
        instructions: "Inspect changes and report findings by severity.",
        name: "code-review",
      })),
    };
    const session = new CliAgentSession({
      cwd,
      discoverHooks: false,
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
      },
      homeDir,
      sessionId: "skill-management",
      skillGenerator,
    });

    try {
      const created = await session.createSkill("给我创建一个代码 review 的技能", ["skills"]);

      expect(created).toMatchObject({
        name: "code-review",
        source: "user",
        version: "0.0.0-local",
      });
      expect(await session.skills()).toContainEqual(created);
      expect(
        await readFile(join(homeDir, ".yiku", "skills", "code-review", "SKILL.md"), "utf8"),
      ).toContain("Inspect changes and report findings by severity.");
      const installed = await session.installSkill(installSource, undefined, ["skills"]);
      expect(installed).toMatchObject({
        name: "installed-review",
        source: "user",
      });
      expect(await session.skills()).toContainEqual(installed);
      expect(
        await readFile(join(homeDir, ".yiku", "skills", "installed-review", "SKILL.md"), "utf8"),
      ).toContain("Review changes from the installed Skill.");
      await expect(session.createSkill("duplicate")).rejects.toThrow("already exists");
      Object.assign(session, { skillCreationService: undefined });
      await expect(session.createSkill("without service")).rejects.toThrow(
        "did not create a Skill service",
      );

      const readOnly = new CliAgentSession({
        accessMode: "read-only",
        cwd,
        discoverHooks: false,
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        homeDir,
        sessionId: "read-only-skill-management",
        skillGenerator: {
          generate: async () => ({
            description: "Checks code. Invoke when code needs inspection.",
            instructions: "Inspect code.",
            name: "read-only-review",
          }),
        },
      });
      try {
        await expect(readOnly.createSkill("create")).rejects.toThrow("read-only mode");
        await expect(readOnly.installSkill(installSource)).rejects.toThrow("read-only mode");
      } finally {
        await readOnly.close("other");
      }
    } finally {
      await session.close("other").catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });
});
