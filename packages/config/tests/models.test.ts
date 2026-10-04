import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultModelsConfigPath, loadModelsConfig } from "../src/models.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("loadModelsConfig", () => {
  it("loads config.yaml from ~/.yiku/config.yaml", () => {
    const homeDir = createTempDir();
    const configPath = getDefaultModelsConfigPath(homeDir);
    mkdirSync(join(homeDir, ".yiku"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "models:",
        "  default: code",
        "  items:",
        "    code:",
        "      baseURL: https://example.test/v1",
        "      name: gpt-4o-mini",
        "      apiKeyEnv: OPENAI_API_KEY",
        "      agentName: Code Agent",
        "      instructions: Review code changes.",
      ].join("\n"),
    );

    expect(loadModelsConfig({ homeDir })).toEqual({
      models: {
        default: "code",
        items: {
          code: {
            agentName: "Code Agent",
            apiKeyEnv: "OPENAI_API_KEY",
            baseURL: "https://example.test/v1",
            instructions: "Review code changes.",
            name: "gpt-4o-mini",
          },
        },
      },
    });
  });

  it("returns an empty config when the file is missing", () => {
    expect(loadModelsConfig({ homeDir: createTempDir() })).toEqual({});
  });

  it("loads from an explicit config path", () => {
    const cwd = createTempDir();
    const configPath = join(cwd, "custom-config.yaml");
    writeFileSync(configPath, "other: value\n");

    expect(loadModelsConfig({ configPath })).toEqual({
      other: "value",
    });
  });

  it("returns raw object content without validating model shape", () => {
    const homeDir = createTempDir();
    mkdirSync(join(homeDir, ".yiku"), { recursive: true });
    writeFileSync(
      getDefaultModelsConfigPath(homeDir),
      "models:\n  default: 1\n  items:\n    - invalid\n",
    );

    expect(loadModelsConfig({ homeDir })).toEqual({
      models: {
        default: 1,
        items: ["invalid"],
      },
    });
  });

  it("returns an empty config for non-object YAML roots", () => {
    const homeDir = createTempDir();
    mkdirSync(join(homeDir, ".yiku"), { recursive: true });
    writeFileSync(getDefaultModelsConfigPath(homeDir), "- invalid\n");

    expect(loadModelsConfig({ homeDir })).toEqual({});
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yiku-models-"));
  tempDirs.push(dir);

  return dir;
}
