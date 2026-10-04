import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig } from "@yiku/config";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../../src/migration/config-migrator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("migrateLegacyConfig", () => {
  it("merges legacy global and project config into the new files", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    await mkdir(join(homeDir, ".yiku-agent"), { recursive: true });
    await mkdir(join(homeDir, ".yiku"), { recursive: true });
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await writeFile(
      join(homeDir, ".yiku-agent", "config.yaml"),
      "models:\n  default: global\nmemory:\n  enabled: true\n",
    );
    await writeFile(
      join(homeDir, ".yiku", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "echo global", type: "command" }] }],
        },
      }),
    );
    await writeFile(
      join(workspaceDir, ".yiku", "config.yaml"),
      "models:\n  default: legacy-local\nruntime:\n  maxTurnsPerStage: 20\n",
    );
    await writeFile(
      join(workspaceDir, ".yiku", "settings.local.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: "echo local", type: "command" }] }],
        },
      }),
    );
    await writeFile(join(workspaceDir, "config.yaml"), "models:\n  default: current-local\n");

    const result = await migrateLegacyConfig({ homeDir, workspaceDir });

    expect(result.migratedPaths).toHaveLength(4);
    expect(loadModelsConfig({ configPath: join(homeDir, ".yiku", "config.yaml") })).toMatchObject({
      hooks: {
        Stop: expect.any(Array),
      },
      memory: { enabled: true },
      models: { default: "global" },
    });
    expect(loadModelsConfig({ configPath: join(workspaceDir, "config.yaml") })).toMatchObject({
      hooks: {
        UserPromptSubmit: expect.any(Array),
      },
      models: { default: "current-local" },
      runtime: { maxTurnsPerStage: 20 },
    });
    for (const path of result.migratedPaths) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("does nothing without legacy sources", async () => {
    const root = await temporaryDirectory();
    await expect(
      migrateLegacyConfig({
        homeDir: join(root, "home"),
        workspaceDir: join(root, "workspace"),
      }),
    ).resolves.toEqual({ migratedPaths: [] });
  });

  it("preserves an invalid legacy Hook document", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const legacyPath = join(workspaceDir, ".yiku", "settings.json");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await writeFile(legacyPath, "[]\n");

    await expect(migrateLegacyConfig({ homeDir, workspaceDir })).rejects.toThrow(
      "Legacy Hook settings must be an object",
    );
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(join(workspaceDir, "config.yaml"))).toBe(false);
  });

  it("preserves legacy config when the target cannot be replaced", async () => {
    const root = await temporaryDirectory();
    const homeDir = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const legacyPath = join(workspaceDir, ".yiku", "config.yaml");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(join(workspaceDir, "config.yaml"), { recursive: true });
    await writeFile(legacyPath, "memory:\n  enabled: false\n");

    await expect(migrateLegacyConfig({ homeDir, workspaceDir })).rejects.toThrow();
    expect(existsSync(legacyPath)).toBe(true);
    expect((await readdir(workspaceDir)).some((name) => name.endsWith(".yiku-config.tmp"))).toBe(
      false,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-config-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}
