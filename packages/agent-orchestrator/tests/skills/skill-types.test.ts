import { describe, expect, it } from "vitest";
import {
  createSkillDescriptor,
  createSkillSnapshot,
  SKILL_MAX_CONTENT_BYTES,
} from "../../src/skills/skill-types.js";

describe("skill types", () => {
  it("creates immutable descriptors and snapshots", () => {
    const descriptor = createSkillDescriptor({
      agentTypes: ["research", "code", "code"],
      allowedTools: "Read",
      compatibility: "Requires git.",
      description: "Review code changes.",
      digest: "a".repeat(64),
      instructions: "Inspect behavior before suggesting changes.",
      license: "Apache-2.0",
      metadata: { category: "review" },
      mcpTargets: ["codebase/search_*", "codebase/search_*"],
      name: "code-review",
      path: "/workspace/.yiku/skills/code-review/SKILL.md",
      source: "project",
      version: "1.2.3",
    });
    const snapshot = createSkillSnapshot(descriptor, "2026-08-08T00:00:00.000Z");

    expect(descriptor.agentTypes).toEqual(["code", "research"]);
    expect(descriptor.metadata).toEqual({ category: "review" });
    expect(descriptor.mcpTargets).toEqual(["codebase/search_*"]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.agentTypes)).toBe(true);
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
    expect(snapshot).toMatchObject({
      digest: "a".repeat(64),
      resolvedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects invalid names, sources, digests, and oversized instructions", () => {
    const valid = {
      agentTypes: ["code"],
      description: "Review code.",
      digest: "a".repeat(64),
      instructions: "Review.",
      mcpTargets: [],
      path: "/workspace/SKILL.md",
      source: "project" as const,
      version: "1.0.0",
    };

    expect(() => createSkillDescriptor({ ...valid, name: "Code Review" })).toThrow(
      "Skill name must use kebab-case",
    );
    expect(() => createSkillDescriptor({ ...valid, digest: "invalid", name: "review" })).toThrow(
      "Skill digest",
    );
    expect(() =>
      createSkillDescriptor({
        ...valid,
        instructions: "x".repeat(SKILL_MAX_CONTENT_BYTES + 1),
        name: "review",
      }),
    ).toThrow("Skill content exceeds");
    expect(() =>
      createSkillDescriptor({
        ...valid,
        name: "review",
        source: "remote" as never,
      }),
    ).toThrow("Skill source");
  });

  it("rejects invalid descriptions, paths, versions, targets, and snapshot dates", () => {
    const valid = {
      agentTypes: ["code"],
      description: "Review code.",
      digest: "a".repeat(64),
      instructions: "Review.",
      mcpTargets: [],
      name: "review",
      path: "/workspace/SKILL.md",
      source: "user" as const,
      version: "0.0.0-local",
    };

    expect(() => createSkillDescriptor({ ...valid, description: "x".repeat(1_025) })).toThrow(
      "at most 1024",
    );
    expect(() => createSkillDescriptor({ ...valid, compatibility: "x".repeat(501) })).toThrow(
      "at most 500",
    );
    expect(() =>
      createSkillDescriptor({
        ...valid,
        metadata: { owner: 42 as never },
      }),
    ).toThrow("metadata values must be strings");
    expect(() => createSkillDescriptor({ ...valid, path: "relative/SKILL.md" })).toThrow(
      "must be absolute",
    );
    expect(() => createSkillDescriptor({ ...valid, version: "latest" })).toThrow("valid SemVer");
    expect(() => createSkillDescriptor({ ...valid, mcpTargets: [" "] })).toThrow(
      "MCP target must be non-empty",
    );
    expect(() => createSkillDescriptor({ ...valid, agentTypes: ["Code Agent"] })).toThrow(
      "Agent type must use kebab-case",
    );

    const descriptor = createSkillDescriptor(valid);
    expect(() => createSkillSnapshot(descriptor, "invalid")).toThrow("must be a valid date");
  });
});
