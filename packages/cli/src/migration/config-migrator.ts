import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  loadModelsConfig,
  type ModelsConfig,
  mergeConfig,
  serializeModelsConfig,
  YikuPaths,
} from "@yiku/config";

export interface ConfigMigrationOptions {
  readonly homeDir: string;
  readonly workspaceDir: string;
}

export interface ConfigMigrationResult {
  readonly migratedPaths: readonly string[];
}

export async function migrateLegacyConfig(
  options: ConfigMigrationOptions,
): Promise<ConfigMigrationResult> {
  const paths = new YikuPaths(options);
  const migratedPaths = [
    ...(await migrateConfigTarget({
      legacyConfigPaths: [join(paths.homeDir, ".yiku-agent", "config.yaml")],
      legacySettingsPaths: [join(paths.yikuDir, "settings.json")],
      mode: 0o600,
      targetPath: paths.configFilePath,
    })),
    ...(await migrateConfigTarget({
      legacyConfigPaths: [join(paths.workspaceDir, ".yiku", "config.yaml")],
      legacySettingsPaths: [
        join(paths.workspaceDir, ".yiku", "settings.json"),
        join(paths.workspaceDir, ".yiku", "settings.local.json"),
      ],
      mode: 0o644,
      targetPath: join(paths.workspaceDir, "config.yaml"),
    })),
  ];
  await removeIfEmpty(join(paths.homeDir, ".yiku-agent"));
  await removeIfEmpty(join(paths.workspaceDir, ".yiku"));
  return {
    migratedPaths: Object.freeze(migratedPaths),
  };
}

interface ConfigTargetMigration {
  readonly legacyConfigPaths: readonly string[];
  readonly legacySettingsPaths: readonly string[];
  readonly mode: number;
  readonly targetPath: string;
}

async function migrateConfigTarget(options: ConfigTargetMigration): Promise<readonly string[]> {
  const legacyConfigs = options.legacyConfigPaths.filter(fileExists);
  const legacySettings = options.legacySettingsPaths.filter(fileExists);
  if (legacyConfigs.length === 0 && legacySettings.length === 0) {
    return [];
  }

  let merged: ModelsConfig = {};
  for (const path of legacyConfigs) {
    merged = mergeConfig(merged, loadModelsConfig({ configPath: path }));
  }
  for (const path of legacySettings) {
    merged = mergeConfig(merged, await readJsonConfig(path));
  }
  merged = mergeConfig(merged, loadModelsConfig({ configPath: options.targetPath }));

  await writeConfig(options.targetPath, merged, options.mode);
  const sources = [...legacyConfigs, ...legacySettings];
  await Promise.all(sources.map((path) => rm(path, { force: true })));
  return sources;
}

async function readJsonConfig(path: string): Promise<ModelsConfig> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Legacy Hook settings must be an object: ${path}`);
  }
  return value as ModelsConfig;
}

async function writeConfig(path: string, config: ModelsConfig, mode: number): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.yiku-config.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(serializeModelsConfig(config), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

async function removeIfEmpty(path: string): Promise<void> {
  if (existsSync(path) && (await readdir(path)).length === 0) {
    await rm(path, { force: true, recursive: true });
  }
}
