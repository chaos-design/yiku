import type { Tool } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { CapabilityScope } from "../../src/skills/capability-scope.js";
import { DefaultSkillRegistry } from "../../src/skills/registry.js";

describe("CapabilityScope", () => {
  it("resolves built-in and registered Skill capabilities", () => {
    const reviewTool = { name: "reviewTool" } as Tool;
    const registry = new DefaultSkillRegistry();
    registry.register({
      instructions: "Review the result.",
      name: "review",
      path: "/skills/review/SKILL.md",
      tools: [reviewTool],
    });
    const scope = new CapabilityScope({ registry });

    try {
      expect(scope.resolveTools(["code"]).map((tool) => tool.name)).toEqual([
        "bashTool",
        "grepTool",
        "lsTool",
        "readTool",
        "editTool",
        "writeTool",
        "treeTool",
        "askUserTool",
      ]);
      expect(scope.resolveTools(["tasks"]).map((tool) => tool.name)).toEqual(["todoWriteTool"]);
      expect(scope.resolveTools(["review"])).toEqual([reviewTool]);
      expect(scope.resolveInstructions(["code", "review"])).toContain("Skill root: /skills/review");
      expect(scope.resolveInstructions(["code", "review"])).toContain("Review the result.");
    } finally {
      scope.close();
    }
  });

  it("shares tool instances and closes idempotently", () => {
    const scope = new CapabilityScope();
    const first = scope.resolveTools(["code"]);
    const second = scope.resolveTools(["code"]);

    expect(second).toEqual(first);
    expect(second[0]).toBe(first[0]);
    scope.close();
    scope.close();
  });

  it("merges session-scoped tools into their declared Skill", () => {
    const registry = new DefaultSkillRegistry();
    const registeredTool = { name: "registeredTool" } as Tool;
    const sessionTool = { name: "mcp__policy__evaluate" } as Tool;
    registry.register({ name: "policy", tools: [registeredTool] });
    const scope = new CapabilityScope({
      registry,
      skillTools: {
        policy: [sessionTool],
      },
    });

    try {
      expect(scope.resolveTools(["policy"])).toEqual([registeredTool, sessionTool]);
    } finally {
      scope.close();
    }
  });

  it("uses code and tasks by default and keeps read-only tools available for upgrades", () => {
    const writable = new CapabilityScope();
    const readOnly = new CapabilityScope({ accessMode: "read-only" });

    try {
      expect(writable.resolveTools().map((tool) => tool.name)).toContain("todoWriteTool");
      expect(readOnly.resolveTools().map((tool) => tool.name)).toEqual([
        "bashTool",
        "grepTool",
        "lsTool",
        "readTool",
        "editTool",
        "writeTool",
        "treeTool",
        "askUserTool",
        "todoWriteTool",
      ]);
    } finally {
      writable.close();
      readOnly.close();
    }
  });

  it("rejects unknown Skills and duplicate resolved tool names", () => {
    const registry = new DefaultSkillRegistry();
    registry.register({
      name: "duplicate",
      tools: [{ name: "grepTool" } as Tool],
    });
    const scope = new CapabilityScope({ registry });

    try {
      expect(() => scope.resolveTools(["missing"])).toThrow("Unknown skill: missing");
      expect(() => scope.resolveTools(["code", "duplicate"])).toThrow(
        "Duplicate tool name: grepTool",
      );
    } finally {
      scope.close();
    }
  });

  it("resolves custom Hook capabilities and reserves built-in names", () => {
    const registry = new DefaultSkillRegistry();
    const hook = { name: "audit", onOperation: vi.fn() };
    registry.register({
      hookFrontmatter: "---\nhooks: {}\n---",
      hooks: [hook],
      name: "review",
      path: "/skills/review.md",
    });
    const scope = new CapabilityScope({ registry });

    try {
      expect(scope.resolveHooks(["code", "review"])).toEqual([hook]);
      expect(scope.resolveHookComponents(["tasks", "review"])).toEqual([
        {
          componentId: "review",
          content: "---\nhooks: {}\n---",
          path: "/skills/review.md",
          type: "skill",
        },
      ]);
      expect(scope.resolveHooks(["code"])).toEqual([]);
      expect(scope.resolveHookComponents(["tasks"])).toEqual([]);
      expect(scope.resolveTools(["delegate"])).toEqual([]);
    } finally {
      scope.close();
    }

    const reserved = new DefaultSkillRegistry();
    reserved.register({ name: "code" });
    expect(() => new CapabilityScope({ registry: reserved })).toThrow("reserved");
  });
});
