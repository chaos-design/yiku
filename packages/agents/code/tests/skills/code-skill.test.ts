import { describe, expect, it, vi } from "vitest";
import { createCodeSkill } from "../../src/skills/code-skill.js";

describe("createCodeSkill", () => {
  it("creates the built-in code skill with tools", () => {
    const permissionApprovalHandler = vi.fn();
    const created = createCodeSkill({
      instructions: "Use code tools.",
      permissionApprovalHandler,
    });

    expect(created.skill).toEqual({
      description: "Code editing, shell, filesystem, search, and todo capabilities.",
      instructions: "Use code tools.",
      name: "code",
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "bashTool",
        }),
      ]),
    });

    created.close();
  });

  it("creates the code skill without optional instructions", () => {
    const created = createCodeSkill();

    expect(created.skill.instructions).toBeUndefined();
    created.close();
  });
});
