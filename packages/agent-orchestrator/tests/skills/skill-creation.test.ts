import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSkillStore } from "../../src/skills/project-skill-store.js";
import { DefaultSkillRegistry } from "../../src/skills/registry.js";
import {
  parseSkillDraft,
  SkillCreationService,
  type SkillGenerator,
} from "../../src/skills/skill-creation.js";
import { discoverSkills } from "../../src/skills/skill-discovery.js";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Skill creation", () => {
  it("validates and freezes generated Skill drafts", () => {
    const draft = parseSkillDraft({
      description: "Reviews code. Invoke when changes need review.",
      instructions: "Inspect the diff.",
      name: "code-review",
    });

    expect(draft).toEqual({
      description: "Reviews code. Invoke when changes need review.",
      instructions: "Inspect the diff.",
      name: "code-review",
    });
    expect(Object.isFrozen(draft)).toBe(true);
    expect(() => parseSkillDraft({ ...draft, extra: true })).toThrow();
    expect(() => parseSkillDraft({ ...draft, name: "Code Review" })).toThrow();
  });

  it("creates, discovers, and registers a generated Skill", async () => {
    const workspaceDir = await temporaryDirectory();
    const homeDir = await temporaryDirectory();
    const generator = skillGenerator("code-review");
    const runtime = new SkillRuntime({
      discovery: () => discoverSkills({ homeDir, workspaceDir }),
    });
    await runtime.discover();
    const builtin = runtime.inspect("code-review");
    expect(builtin).toMatchObject({ source: "builtin" });
    if (builtin === undefined) {
      throw new Error("Expected built-in code-review Skill.");
    }
    const registry = new DefaultSkillRegistry();
    registry.register({
      description: builtin.description,
      instructions: builtin.instructions,
      name: "code-review",
      path: builtin.path,
    });
    const service = new SkillCreationService({
      generator,
      registry,
      runtime,
      store: new ProjectSkillStore({ workspaceDir }),
    });

    const descriptor = await service.create("Create a code review Skill");

    expect(generator.generate).toHaveBeenCalledWith("Create a code review Skill", {});
    expect(descriptor).toMatchObject({ name: "code-review", source: "project" });
    expect(runtime.inspect("code-review")).toEqual(descriptor);
    expect(registry.get("code-review")).toMatchObject({
      instructions: "Instructions for code-review.",
      name: "code-review",
    });

    await expect(
      new SkillCreationService({
        generator: skillGenerator("code-review"),
        registry: new DefaultSkillRegistry(),
        runtime,
        store: new ProjectSkillStore({ workspaceDir }),
      }).create("Create it again"),
    ).rejects.toThrow("already exists");
  });

  it("rejects reserved and existing generated names before writing", async () => {
    const workspaceDir = await temporaryDirectory();
    const homeDir = await temporaryDirectory();
    const runtime = new SkillRuntime({
      discovery: () => discoverSkills({ homeDir, workspaceDir }),
    });
    await runtime.discover();
    const registry = new DefaultSkillRegistry();
    registry.register({ name: "existing" });

    const reserved = new SkillCreationService({
      generator: skillGenerator("skills"),
      registry,
      runtime,
      store: new ProjectSkillStore({ workspaceDir }),
    });
    const existing = new SkillCreationService({
      generator: skillGenerator("existing"),
      registry,
      runtime,
      store: new ProjectSkillStore({ workspaceDir }),
    });

    await expect(reserved.create("reserved", { reservedNames: ["skills"] })).rejects.toThrow(
      "reserved",
    );
    await expect(existing.create("existing")).rejects.toThrow("already exists");
  });

  it("rejects empty intents and reports failed post-write discovery", async () => {
    const generator = skillGenerator("missing");
    const signal = new AbortController().signal;
    const runtime = {
      discover: vi
        .fn()
        .mockResolvedValueOnce({ diagnostics: [], shadowed: [], skills: [] })
        .mockResolvedValueOnce({
          diagnostics: [
            {
              code: "SKILL_INVALID_FRONTMATTER",
              message: "Invalid generated content.",
              path: "/workspace/.yiku/skills/missing/SKILL.md",
              severity: "error",
            },
          ],
          shadowed: [],
          skills: [],
        }),
      inspect: vi.fn(() => undefined),
    } as unknown as SkillRuntime;
    const service = new SkillCreationService({
      generator,
      registry: new DefaultSkillRegistry(),
      runtime,
      store: {
        save: vi.fn(async () => ({}) as never),
      },
    });

    await expect(service.create("   ")).rejects.toThrow("must be non-empty");
    expect(generator.generate).not.toHaveBeenCalled();
    await expect(service.create("missing", { signal })).rejects.toThrow("was not discovered");
    expect(generator.generate).toHaveBeenLastCalledWith("missing", { signal });
    await expect(service.create("invalid")).rejects.toThrow(
      "Created Skill is invalid: Invalid generated content.",
    );
  });
});

function skillGenerator(name: string): SkillGenerator & {
  readonly generate: ReturnType<typeof vi.fn<SkillGenerator["generate"]>>;
} {
  return {
    generate: vi.fn(async () => ({
      description: `Runs ${name}. Invoke when ${name} is requested.`,
      instructions: `Instructions for ${name}.`,
      name,
    })),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-skill-creation-"));
  temporaryDirectories.push(directory);
  return directory;
}
