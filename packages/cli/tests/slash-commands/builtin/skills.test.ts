import { describe, expect, it, vi } from "vitest";
import { skillsCommand } from "../../../src/slash-commands/builtin/skills.js";
import type { SlashCommandContext } from "../../../src/slash-commands/types.js";

describe("skillsCommand", () => {
  it("creates a Skill from the raw intent and handles an empty catalog", async () => {
    const createSkill = vi.fn(async () => ({
      name: "code-review",
      path: "/home/test/.yiku/skills/code-review/SKILL.md",
    }));
    const listSkills = vi.fn(() => []);
    const context = { createSkill, listSkills } as unknown as SlashCommandContext;

    await expect(
      skillsCommand.execute(context, {
        raw: "给我创建一个代码 review 的技能",
        values: ["给我创建一个代码", "review", "的技能"],
      }),
    ).resolves.toEqual({
      kind: "success",
      lineColors: ["white", "white", "green"],
      message: [
        "Name: code-review",
        "Path: /home/test/.yiku/skills/code-review/SKILL.md",
        "Command: /code-review",
      ].join("\n"),
      title: "Skill Created",
    });
    expect(createSkill).toHaveBeenCalledWith("给我创建一个代码 review 的技能");
    createSkill.mockResolvedValueOnce({ name: "minimal" });
    await expect(
      skillsCommand.execute(context, { raw: "minimal Skill", values: ["minimal", "Skill"] }),
    ).resolves.toMatchObject({
      message: "Name: minimal\nPath: Created\nCommand: /minimal",
    });
    await expect(skillsCommand.execute(context, { raw: "", values: [] })).resolves.toEqual({
      kind: "success",
      message: "No Skill commands are configured.",
      title: "Skills (0)",
    });
  });

  it("installs and explicitly creates user Skills with stable usage errors", async () => {
    const createSkill = vi.fn(async () => ({
      name: "created-skill",
      path: "/home/test/.yiku/skills/created-skill/SKILL.md",
    }));
    const installSkill = vi.fn(async () => ({
      name: "installed-skill",
      path: "/home/test/.yiku/skills/installed-skill/SKILL.md",
    }));
    const context = {
      createSkill,
      installSkill,
      listSkills: () => [],
    } as unknown as SlashCommandContext;

    await expect(
      skillsCommand.execute(context, {
        raw: "install acme/skills installed-skill",
        values: ["install", "acme/skills", "installed-skill"],
      }),
    ).resolves.toEqual({
      kind: "success",
      lineColors: ["white", "white", "green"],
      message: [
        "Name: installed-skill",
        "Path: /home/test/.yiku/skills/installed-skill/SKILL.md",
        "Command: /installed-skill",
      ].join("\n"),
      title: "Skill Installed",
    });
    expect(installSkill).toHaveBeenCalledWith("acme/skills", "installed-skill");

    await expect(
      skillsCommand.execute(context, {
        raw: "create review pull requests",
        values: ["create", "review", "pull", "requests"],
      }),
    ).resolves.toMatchObject({
      message:
        "Name: created-skill\nPath: /home/test/.yiku/skills/created-skill/SKILL.md\nCommand: /created-skill",
      title: "Skill Created",
    });
    expect(createSkill).toHaveBeenCalledWith("review pull requests");

    for (const values of [
      ["install"],
      ["install", "one", "two", "three"],
      ["create"],
      ["list", "extra"],
    ]) {
      await expect(
        skillsCommand.execute(context, {
          raw: values.join(" "),
          values,
        }),
      ).resolves.toEqual({
        kind: "error",
        message:
          "Usage: /skills [list] | /skills install <source> [skill] | /skills create <description>",
        title: "Command Error",
      });
    }
  });

  it("formats configured, built-in, project, and user Skills with bounded metadata", async () => {
    const context = {
      listSkills: () => [
        {
          name: "configured-skill",
        },
        {
          description: "Built-in capability.",
          digest: "abcdef1234567890",
          name: "builtin-skill",
          source: "builtin" as const,
          version: "1.0.0",
        },
        {
          description: "Project\ncapability.",
          name: "project-skill",
          source: "project" as const,
        },
        {
          digest: "1234567890abcdef",
          name: "user-skill",
          source: "user" as const,
          version: "1.2.3",
        },
      ],
    } as unknown as SlashCommandContext;

    await expect(skillsCommand.execute(context, { raw: "", values: [] })).resolves.toEqual({
      kind: "success",
      lineColors: [
        "cyan",
        "green",
        "gray",
        "gray",
        "magenta",
        "green",
        "gray",
        "gray",
        "yellow",
        "green",
        "gray",
        "gray",
        "white",
        "green",
        "gray",
      ],
      lineIndents: [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
      message: [
        "BUILTIN · 1",
        "├ /builtin-skill · v1.0.0 · abcdef12",
        "└ Built-in capability.",
        "",
        "PROJECT · 1",
        "├ /project-skill · v0.0.0-local",
        "└ Project capability.",
        "",
        "USER · 1",
        "├ /user-skill · v1.2.3 · 12345678",
        "└ Run configured Skill",
        "",
        "CONFIGURED · 1",
        "├ /configured-skill · configured",
        "└ Run configured Skill",
      ].join("\n"),
      title: "Skills (4)",
    });
  });
});
