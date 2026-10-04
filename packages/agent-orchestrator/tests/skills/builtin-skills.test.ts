import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuiltinSkillsDirectory } from "../../src/skills/builtin-skills.js";
import { parseSkillMarkdown } from "../../src/skills/skill-parser.js";

const BUILTIN_SKILL_NAMES = [
  "code-review",
  "find-skills",
  "implementation-planning",
  "security-review",
  "skill-creator",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
] as const;

describe("built-in Skills", () => {
  it("resolves source and distribution package layouts", () => {
    expect(
      resolveBuiltinSkillsDirectory(new URL("file:///package/src/skills/builtin-skills.ts")),
    ).toBe("/package/src/skills/builtin");
    expect(
      resolveBuiltinSkillsDirectory(new URL("file:///package/dist/skills/builtin-skills.js")),
    ).toBe("/package/src/skills/builtin");
  });

  it("ships the complete valid Code Agent Skill catalog", async () => {
    const directory = resolveBuiltinSkillsDirectory();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();

    expect(entries).toEqual(BUILTIN_SKILL_NAMES);

    for (const name of BUILTIN_SKILL_NAMES) {
      const path = join(directory, name, "SKILL.md");
      const parsed = parseSkillMarkdown(await readFile(path, "utf8"), path, "builtin");

      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect(parsed.descriptor).toMatchObject({
        agentTypes: ["code"],
        mcpTargets: [],
        name,
        source: "builtin",
        version: "1.0.0",
      });
      expect(parsed.descriptor.description.length).toBeLessThanOrEqual(200);
      expect(parsed.descriptor.instructions.length).toBeGreaterThan(0);
    }
  });

  it("uses the fixed CLI Skill installation directory without scope confirmation", async () => {
    const directory = resolveBuiltinSkillsDirectory();

    for (const name of ["find-skills", "skill-creator"]) {
      const path = join(directory, name, "SKILL.md");
      const parsed = parseSkillMarkdown(await readFile(path, "utf8"), path, "builtin");

      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      const instructions = parsed.descriptor.instructions.replaceAll(/\s+/gu, " ");
      expect(instructions).toContain("~/.yiku/skills/<name>/");
      expect(instructions).toContain(
        "do not ask the user to choose or confirm an installation directory",
      );
      expect(instructions).not.toContain("<workspace>/.yiku/skills");
    }
  });
});
