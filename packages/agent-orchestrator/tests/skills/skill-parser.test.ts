import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../src/skills/skill-parser.js";
import { SKILL_MAX_CONTENT_BYTES } from "../../src/skills/skill-types.js";

describe("parseSkillMarkdown", () => {
  it("parses and normalizes a complete SKILL.md", () => {
    const result = parseSkillMarkdown(
      [
        "---",
        "name: code-review",
        "description: Review code changes.",
        "version: 1.2.3",
        "license: Apache-2.0",
        "compatibility: Requires git.",
        "allowed-tools: Bash(git:*) Read",
        "metadata:",
        "  author: yiku",
        "  category: review",
        "mcp:",
        "  - codebase/search_*",
        "  - codebase/search_*",
        "agentTypes:",
        "  - research",
        "  - code",
        "---",
        "",
        "Inspect behavior before suggesting changes.",
      ].join("\r\n"),
      "/workspace/.yiku/skills/code-review/SKILL.md",
      "project",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.descriptor).toMatchObject({
      agentTypes: ["code", "research"],
      allowedTools: "Bash(git:*) Read",
      compatibility: "Requires git.",
      description: "Review code changes.",
      instructions: "Inspect behavior before suggesting changes.",
      license: "Apache-2.0",
      metadata: {
        author: "yiku",
        category: "review",
      },
      mcpTargets: ["codebase/search_*"],
      name: "code-review",
      source: "project",
      version: "1.2.3",
    });
    expect(result.descriptor.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns stable diagnostics for invalid metadata", () => {
    const cases = [
      ["missing-frontmatter", "# Skill"],
      ["missing-description", "---\nname: review\n---\nReview."],
      ["unknown-field", "---\nname: review\ndescription: Review.\ncommand: rm -rf /\n---\nReview."],
      ["invalid-version", "---\nname: review\ndescription: Review.\nversion: latest\n---\nReview."],
      ["invalid-mcp", '---\nname: review\ndescription: Review.\nmcp: [""]\n---\nReview.'],
      ["invalid-metadata", "---\nname: review\ndescription: Review.\nmetadata: []\n---\nReview."],
      [
        "invalid-allowed-tools",
        "---\nname: review\ndescription: Review.\nallowed-tools: []\n---\nReview.",
      ],
    ] as const;

    for (const [label, content] of cases) {
      const result = parseSkillMarkdown(content, `/workspace/${label}/SKILL.md`, "project");
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.code).toBe("SKILL_INVALID_FRONTMATTER");
        expect(result.diagnostic.path).toContain(label);
      }
    }
  });

  it("uses the local version default and rejects oversized files", () => {
    const valid = parseSkillMarkdown(
      "---\nname: review\ndescription: Review.\n---\nReview.",
      "/workspace/review/SKILL.md",
      "user",
    );
    expect(valid.ok && valid.descriptor.version).toBe("0.0.0-local");

    const oversized = parseSkillMarkdown(
      `---\nname: review\ndescription: Review.\n---\n${"x".repeat(SKILL_MAX_CONTENT_BYTES)}`,
      "/workspace/large/SKILL.md",
      "user",
    );
    expect(oversized).toMatchObject({
      diagnostic: {
        code: "SKILL_INVALID_FRONTMATTER",
      },
      ok: false,
    });
  });

  it("produces the same digest for LF and CRLF input", () => {
    const lf = "---\nname: review\ndescription: Review.\n---\nInspect.";
    const crlf = lf.replaceAll("\n", "\r\n");
    const left = parseSkillMarkdown(lf, "/workspace/review/SKILL.md", "project");
    const right = parseSkillMarkdown(crlf, "/workspace/review/SKILL.md", "project");

    expect(left.ok && left.descriptor.digest).toBe(right.ok && right.descriptor.digest);
  });
});
