import { describe, expect, it } from "vitest";
import { SkillRuntime, type SkillRuntimeError } from "../../src/skills/skill-runtime.js";
import { createSkillDescriptor, type SkillDiscoveryResult } from "../../src/skills/skill-types.js";

describe("SkillRuntime", () => {
  it("discovers, lists, inspects, and snapshots compatible skills", async () => {
    const runtime = new SkillRuntime({
      discovery: async () =>
        result([
          descriptor("review", ["code"], ["codebase/search_*"]),
          descriptor("research-only", ["research"]),
        ]),
      isMcpTargetAllowed: (target) => target.startsWith("codebase/"),
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    await runtime.discover();
    expect(runtime.list().map((skill) => skill.name)).toEqual(["research-only", "review"]);
    expect(runtime.inspect("review")?.description).toBe("review description");
    const snapshots = runtime.snapshot(["review"], "code");

    expect(snapshots).toEqual([
      expect.objectContaining({
        name: "review",
        resolvedAt: "2026-08-08T00:00:00.000Z",
      }),
    ]);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
  });

  it("rejects incompatible agent types, denied MCP targets, and unknown skills", async () => {
    const runtime = new SkillRuntime({
      discovery: async () =>
        result([
          descriptor("review", ["code"], ["private/search"]),
          descriptor("research-only", ["research"]),
        ]),
      isMcpTargetAllowed: () => false,
    });
    await runtime.discover();

    expect(() => runtime.snapshot(["missing"], "code")).toThrowError(
      expect.objectContaining<Partial<SkillRuntimeError>>({ code: "SKILL_NOT_FOUND" }),
    );
    expect(() => runtime.snapshot(["research-only"], "code")).toThrowError(
      expect.objectContaining<Partial<SkillRuntimeError>>({
        code: "SKILL_AGENT_TYPE_MISMATCH",
      }),
    );
    expect(() => runtime.snapshot(["review"], "code")).toThrowError(
      expect.objectContaining<Partial<SkillRuntimeError>>({
        code: "SKILL_CAPABILITY_DENIED",
      }),
    );
  });

  it("atomically replaces the catalog while preserving existing snapshots", async () => {
    let current = result([descriptor("first", ["code"])]);
    const runtime = new SkillRuntime({
      discovery: async () => current,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    await runtime.discover();
    const snapshot = runtime.snapshot(["first"], "code")[0];

    current = result([descriptor("second", ["code"])]);
    await runtime.discover();

    expect(runtime.inspect("first")).toBeUndefined();
    expect(runtime.list().map((skill) => skill.name)).toEqual(["second"]);
    expect(snapshot?.name).toBe("first");
  });
});

function descriptor(
  name: string,
  agentTypes: readonly string[],
  mcpTargets: readonly string[] = [],
) {
  return createSkillDescriptor({
    agentTypes,
    description: `${name} description`,
    digest: "a".repeat(64),
    instructions: `${name} instructions`,
    mcpTargets,
    name,
    path: `/workspace/${name}/SKILL.md`,
    source: "project",
    version: "1.0.0",
  });
}

function result(skills: SkillDiscoveryResult["skills"]): SkillDiscoveryResult {
  return Object.freeze({
    diagnostics: Object.freeze([]),
    shadowed: Object.freeze([]),
    skills: Object.freeze([...skills]),
  });
}
