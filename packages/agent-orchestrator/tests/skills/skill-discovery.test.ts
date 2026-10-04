import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../../src/skills/skill-discovery.js";

describe("discoverSkills", () => {
  it("discovers all sources with project, user, then built-in precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    const builtinDir = join(root, "builtin");
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");

    try {
      await writeSkill(builtinDir, "builtin", "builtin-only", "Built-in only skill.");
      await writeSkill(builtinDir, "builtin", "shared", "Built-in shared skill.");
      await writeSkill(builtinDir, "builtin", "user-only", "Built-in user skill.");
      await writeSkill(homeDir, "user", "shared", "User shared skill.");
      await writeSkill(homeDir, "user", "user-only", "User only skill.");
      await writeSkill(workspaceDir, "project", "shared", "Project shared skill.");
      await writeSkill(workspaceDir, "project", "project-only", "Project only skill.");

      const result = await discoverSkills({ builtinDir, homeDir, workspaceDir });

      expect(result.skills.map((skill) => skill.name)).toEqual([
        "builtin-only",
        "project-only",
        "shared",
        "user-only",
      ]);
      expect(result.skills.find((skill) => skill.name === "shared")).toMatchObject({
        description: "Project shared skill.",
        source: "project",
      });
      expect(result.skills.find((skill) => skill.name === "user-only")).toMatchObject({
        description: "User only skill.",
        source: "user",
      });
      expect(result.shadowed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "shared", source: "builtin" }),
          expect.objectContaining({ name: "shared", source: "user" }),
          expect.objectContaining({ name: "user-only", source: "builtin" }),
        ]),
      );
      expect(
        result.diagnostics.filter((diagnostic) => diagnostic.code === "SKILL_SHADOWED"),
      ).toHaveLength(3);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("isolates invalid, mismatched, and escaping skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    const builtinDir = join(root, "builtin");
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const outsideDir = join(root, "outside");

    try {
      await mkdir(builtinDir, { recursive: true });
      await writeSkill(workspaceDir, "project", "wrong-directory", "Wrong directory.", "wrong");
      const invalidDir = join(workspaceDir, ".yiku", "skills", "invalid");
      await mkdir(invalidDir, { recursive: true });
      await writeFile(join(invalidDir, "SKILL.md"), "# Missing frontmatter\n");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "SKILL.md"), skillMarkdown("outside", "Outside skill."));
      await symlink(outsideDir, join(workspaceDir, ".yiku", "skills", "escape"));

      const result = await discoverSkills({ builtinDir, homeDir, workspaceDir });

      expect(result.skills).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
        expect.arrayContaining(["SKILL_INVALID_FRONTMATTER", "SKILL_PATH_ESCAPE"]),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SKILL_INVALID_FRONTMATTER",
          message: "Skill name must match its parent directory: wrong-directory.",
        }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns an empty immutable result when skill directories do not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    try {
      const builtinDir = join(root, "builtin");
      await mkdir(builtinDir, { recursive: true });
      const result = await discoverSkills({
        builtinDir,
        homeDir: join(root, "home"),
        workspaceDir: join(root, "workspace"),
      });

      expect(result).toEqual({ diagnostics: [], shadowed: [], skills: [] });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.skills)).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("isolates unreadable roots, broken entries, and non-Skill files", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    const builtinDir = join(root, "builtin");
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");

    try {
      await mkdir(builtinDir, { recursive: true });
      await mkdir(join(homeDir, ".yiku"), { recursive: true });
      await writeFile(join(homeDir, ".yiku", "skills"), "not a directory");
      const skillsDir = join(workspaceDir, ".yiku", "skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(join(skillsDir, "README.md"), "ignored");
      await symlink("loop", join(skillsDir, "loop"));
      await mkdir(join(skillsDir, "missing"));
      await mkdir(join(skillsDir, "directory-file", "SKILL.md"), { recursive: true });

      const result = await discoverSkills({ builtinDir, homeDir, workspaceDir });

      expect(result.skills).toEqual([]);
      expect(
        result.diagnostics.filter((diagnostic) => diagnostic.code === "SKILL_DISCOVERY_FAILED"),
      ).toHaveLength(3);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets configured Skills shadow built-ins without exposing two catalogs", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    const builtinDir = join(root, "builtin");

    try {
      await writeSkill(builtinDir, "builtin", "code-review", "Built-in review.");

      const result = await discoverSkills({
        builtinDir,
        builtinShadowedBy: ["code-review"],
        homeDir: join(root, "home"),
        workspaceDir: join(root, "workspace"),
      });

      expect(result.skills).toEqual([]);
      expect(result.shadowed).toEqual([
        expect.objectContaining({ name: "code-review", source: "builtin" }),
      ]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SKILL_SHADOWED",
          message: expect.stringContaining("configured Skill"),
          severity: "info",
        }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports a missing built-in directory while ignoring absent local roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "yiku-skills-"));
    const builtinDir = join(root, "missing-builtin");

    try {
      const result = await discoverSkills({
        builtinDir,
        homeDir: join(root, "home"),
        workspaceDir: join(root, "workspace"),
      });

      expect(result.skills).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "SKILL_DISCOVERY_FAILED",
          path: builtinDir,
          severity: "error",
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function writeSkill(
  root: string,
  source: "builtin" | "project" | "user",
  directoryName: string,
  description: string,
  name = directoryName,
): Promise<void> {
  const base =
    source === "builtin" ? join(root, directoryName) : join(root, ".yiku", "skills", directoryName);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "SKILL.md"), skillMarkdown(name, description));
}

function skillMarkdown(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "version: 1.0.0",
    "---",
    "",
    `Instructions for ${name}.`,
  ].join("\n");
}
