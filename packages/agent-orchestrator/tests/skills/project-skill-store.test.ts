import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSkillStore, UserSkillStore } from "../../src/skills/project-skill-store.js";
import { parseSkillMarkdown } from "../../src/skills/skill-parser.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ProjectSkillStore", () => {
  it("atomically creates a validated project SKILL.md with bounded capabilities", async () => {
    const workspaceDir = await temporaryDirectory();
    const store = new ProjectSkillStore({ workspaceDir });

    const descriptor = await store.save({
      description: "Reviews code. Invoke when code changes need inspection.",
      instructions: "Inspect the diff and report findings by severity.",
      name: "code-review",
    });
    const content = await readFile(
      join(workspaceDir, ".yiku", "skills", "code-review", "SKILL.md"),
      "utf8",
    );
    const parsed = parseSkillMarkdown(content, descriptor.path, "project");

    expect(parsed.ok && parsed.descriptor).toMatchObject({
      agentTypes: ["code"],
      mcpTargets: [],
      name: "code-review",
      version: "0.0.0-local",
    });
    expect(content).toContain("Inspect the diff and report findings by severity.");
  });

  it("rejects existing Skills, invalid drafts, and read-only workspaces", async () => {
    const workspaceDir = await temporaryDirectory();
    const store = new ProjectSkillStore({ workspaceDir });
    const draft = {
      description: "Reviews code. Invoke for code review.",
      instructions: "Review the code.",
      name: "review",
    };

    await store.save(draft);
    await expect(store.save(draft)).rejects.toThrow("Skill already exists");
    await expect(store.save({ ...draft, name: "../escape" })).rejects.toThrow();
    await expect(
      new ProjectSkillStore({ workspaceDir, writable: false }).save({
        ...draft,
        name: "read-only",
      }),
    ).rejects.toThrow("read-only mode");
  });

  it("rejects invalid roots, oversized UTF-8 content, and non-directory Skill roots", async () => {
    expect(() => new ProjectSkillStore({ workspaceDir: "relative" })).toThrow("must be absolute");

    const oversizedWorkspace = await temporaryDirectory();
    await expect(
      new ProjectSkillStore({ workspaceDir: oversizedWorkspace }).save({
        description: "Reviews code. Invoke for code review.",
        instructions: "审".repeat(22_000),
        name: "oversized",
      }),
    ).rejects.toThrow("Generated Skill is invalid");

    const invalidWorkspace = await temporaryDirectory();
    await mkdir(join(invalidWorkspace, ".yiku"), { recursive: true });
    await writeFile(join(invalidWorkspace, ".yiku", "skills"), "not a directory");
    await expect(
      new ProjectSkillStore({ workspaceDir: invalidWorkspace }).save({
        description: "Reviews code. Invoke for code review.",
        instructions: "Review the code.",
        name: "review",
      }),
    ).rejects.toThrow();
  });

  it("rejects symbolic-link segments in the project Skill path", async () => {
    const workspaceDir = await temporaryDirectory();
    const outsideDir = await temporaryDirectory();
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await symlink(outsideDir, join(workspaceDir, ".yiku", "skills"));

    await expect(
      new ProjectSkillStore({ workspaceDir }).save({
        description: "Reviews code. Invoke for code review.",
        instructions: "Review the code.",
        name: "review",
      }),
    ).rejects.toThrow("cannot contain symbolic links");
  });

  it("persists user Skills under the global Yiku directory", async () => {
    const homeDir = await temporaryDirectory();
    const store = new UserSkillStore({ homeDir });

    const descriptor = await store.save({
      description: "Reviews code. Invoke when code changes need inspection.",
      instructions: "Inspect the diff and report findings.",
      name: "global-review",
    });

    expect(descriptor).toMatchObject({
      path: expect.stringMatching(/\.yiku\/skills\/global-review\/SKILL\.md$/u),
      source: "user",
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-project-skill-"));
  temporaryDirectories.push(directory);
  return directory;
}
