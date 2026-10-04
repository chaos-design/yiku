import { describe, expect, it } from "vitest";
import { parseHookFrontmatter } from "../../src/config/frontmatter.js";
import { HookConfigError } from "../../src/errors.js";

describe("parseHookFrontmatter", () => {
  it("parses structured hooks from YAML frontmatter", () => {
    expect(
      parseHookFrontmatter(
        `---
name: reviewer
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: pnpm lint
---
Instructions.
`,
        {
          componentId: "reviewer",
          sourceType: "agent",
        },
      ),
    ).toEqual({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                command: "pnpm lint",
                type: "command",
              },
            ],
            matcher: "Bash",
          },
        ],
      },
    });
  });

  it("returns undefined when frontmatter or hooks are absent", () => {
    expect(
      parseHookFrontmatter("Instructions only.", {
        componentId: "reviewer",
        sourceType: "agent",
      }),
    ).toBeUndefined();
    expect(
      parseHookFrontmatter("---\nname: reviewer\n---\nInstructions.", {
        componentId: "reviewer",
        sourceType: "agent",
      }),
    ).toBeUndefined();
  });

  it("rejects unclosed and invalid YAML", () => {
    expect(() =>
      parseHookFrontmatter("---\nhooks: {}", {
        componentId: "reviewer",
        sourceType: "agent",
      }),
    ).toThrow(HookConfigError);
    expect(() =>
      parseHookFrontmatter("---\nhooks: [\n---", {
        componentId: "reviewer",
        sourceType: "agent",
      }),
    ).toThrow("invalid YAML");
  });
});
