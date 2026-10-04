import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export type ModelsConfig = Record<string, unknown>;

export interface LoadModelsConfigOptions {
  readonly configPath?: string;
  readonly homeDir?: string;
}

export function getDefaultModelsConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".yiku", "config.yaml");
}

export function loadModelsConfig(options: LoadModelsConfigOptions = {}): ModelsConfig {
  const configPath = options.configPath ?? getDefaultModelsConfigPath(options.homeDir);

  if (!existsSync(configPath)) {
    return {};
  }

  const loaded = parse(readFileSync(configPath, "utf8"));

  return isRecord(loaded) ? loaded : {};
}

export function serializeModelsConfig(config: ModelsConfig): string {
  return stringify(config, {
    lineWidth: 100,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
