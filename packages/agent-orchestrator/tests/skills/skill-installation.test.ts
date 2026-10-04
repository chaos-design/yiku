import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultSkillRegistry } from "../../src/skills/registry.js";
import { discoverSkills } from "../../src/skills/skill-discovery.js";
import {
  SkillInstallationService,
  type SkillSourceCloner,
} from "../../src/skills/skill-installation.js";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SkillInstallationService", () => {
  it("installs a complete local Skill and refreshes the active catalog", async () => {
    const fixture = await fixtureDirectories();
    const source = join(fixture.root, "source");
    await writeSkill(source, "release-notes");
    await mkdir(join(source, "scripts"));
    await writeFile(join(source, "scripts", "generate.sh"), "#!/bin/sh\nprintf release\n");
    await chmod(join(source, "scripts", "generate.sh"), 0o755);
    const { registry, runtime, service } = await installationService(fixture);

    const descriptor = await service.install(source);

    expect(descriptor).toMatchObject({
      name: "release-notes",
      source: "user",
      version: "1.0.0",
    });
    expect(runtime.inspect("release-notes")).toEqual(descriptor);
    expect(registry.get("release-notes")).toMatchObject({
      instructions: "Generate bounded release notes.",
      path: descriptor.path,
    });
    expect(
      await readFile(
        join(fixture.homeDir, ".yiku", "skills", "release-notes", "scripts", "generate.sh"),
        "utf8",
      ),
    ).toContain("printf release");
    expect(
      (
        await stat(
          join(fixture.homeDir, ".yiku", "skills", "release-notes", "scripts", "generate.sh"),
        )
      ).mode & 0o100,
    ).toBe(0o100);
  });

  it("requires a selector for multi-Skill sources and accepts names or relative paths", async () => {
    const fixture = await fixtureDirectories();
    const source = join(fixture.root, "catalog");
    await writeSkill(join(source, "skills", "one"), "one");
    await writeSkill(join(source, "nested", "skills", "two"), "two");
    const { service } = await installationService(fixture);

    await expect(service.install(source)).rejects.toThrow(
      "Skill source contains multiple Skills. Select one",
    );
    await expect(service.install(source, { selector: "nested/skills/two" })).resolves.toMatchObject(
      {
        name: "two",
      },
    );
    await expect(access(join(fixture.homeDir, ".yiku", "skills", "one"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("clones public GitHub shorthand without requiring a separate package manager", async () => {
    const fixture = await fixtureDirectories();
    const cloneRepository = vi.fn<SkillSourceCloner>(
      async (_repositoryUrl, destination, _options) => {
        await writeSkill(join(destination, "skills", "dependency-audit"), "dependency-audit");
      },
    );
    const { service } = await installationService(fixture, { cloneRepository });

    await expect(
      service.install("acme/agent-skills", { selector: "dependency-audit" }),
    ).resolves.toMatchObject({
      name: "dependency-audit",
      source: "user",
    });
    expect(cloneRepository).toHaveBeenCalledWith(
      "https://github.com/acme/agent-skills.git",
      expect.stringMatching(/yiku-skill-source-.+\/repository$/u),
      {},
    );
  });

  it("rejects invalid, reserved, existing, and read-only installations", async () => {
    const fixture = await fixtureDirectories();
    const invalid = join(fixture.root, "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, "SKILL.md"), "not frontmatter");
    const reserved = join(fixture.root, "reserved");
    await writeSkill(reserved, "skills");
    const source = join(fixture.root, "source");
    await writeSkill(source, "quality-gate");
    const { registry, runtime, service } = await installationService(fixture);

    await expect(service.install(invalid)).rejects.toThrow(
      "Skill source does not contain a valid SKILL.md",
    );
    await expect(service.install(reserved, { reservedNames: ["skills"] })).rejects.toThrow(
      "Skill name is reserved",
    );
    await service.install(source);
    await expect(service.install(source)).rejects.toThrow("Skill already exists");
    await expect(
      new SkillInstallationService({
        homeDir: fixture.homeDir,
        registry,
        runtime,
        workspaceDir: fixture.workspaceDir,
        writable: false,
      }).install(source),
    ).rejects.toThrow("read-only mode");
  });

  it("rejects symbolic links and rolls back a partial target", async () => {
    const fixture = await fixtureDirectories();
    const source = join(fixture.root, "linked");
    const outside = join(fixture.root, "outside.txt");
    await writeSkill(source, "linked-skill");
    await writeFile(outside, "outside");
    await symlink(outside, join(source, "reference.txt"));
    const { service } = await installationService(fixture);

    await expect(service.install(source)).rejects.toThrow("does not allow symbolic links");
    await expect(
      access(join(fixture.homeDir, ".yiku", "skills", "linked-skill")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports unsupported missing sources before invoking Git", async () => {
    const fixture = await fixtureDirectories();
    const cloneRepository = vi.fn<SkillSourceCloner>();
    const { service } = await installationService(fixture, { cloneRepository });

    await expect(service.install("not-a-source")).rejects.toThrow(
      "not a supported GitHub repository",
    );
    expect(cloneRepository).not.toHaveBeenCalled();
  });
});

async function installationService(
  fixture: Awaited<ReturnType<typeof fixtureDirectories>>,
  options: { readonly cloneRepository?: SkillSourceCloner } = {},
) {
  const registry = new DefaultSkillRegistry();
  const runtime = new SkillRuntime({
    discovery: () =>
      discoverSkills({
        homeDir: fixture.homeDir,
        workspaceDir: fixture.workspaceDir,
      }),
  });
  await runtime.discover();
  const service = new SkillInstallationService({
    ...(options.cloneRepository === undefined ? {} : { cloneRepository: options.cloneRepository }),
    homeDir: fixture.homeDir,
    registry,
    runtime,
    workspaceDir: fixture.workspaceDir,
  });
  return { registry, runtime, service };
}

async function fixtureDirectories() {
  const root = await mkdtemp(join(tmpdir(), "yiku-skill-installation-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(homeDir);
  await mkdir(workspaceDir);
  temporaryDirectories.push(root);
  return { homeDir, root, workspaceDir };
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Run ${name}. Invoke when ${name} is requested.`,
      "version: 1.0.0",
      "---",
      "",
      `Generate bounded ${name === "release-notes" ? "release notes" : name}.`,
      "",
    ].join("\n"),
  );
}
