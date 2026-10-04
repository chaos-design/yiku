import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/env.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("loadEnvFile", () => {
  it("loads .env from process cwd by default", () => {
    const previousCwd = process.cwd();
    const cwd = createTempDir();
    writeFileSync(join(cwd, ".env"), "AI_MODEL=from-default-cwd\n");

    try {
      process.chdir(cwd);
      expect(loadEnvFile()).toEqual({
        AI_MODEL: "from-default-cwd",
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("loads .env from the provided current directory", () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, ".env"), "AI_MODEL=from-env\nOPENAI_API_KEY=env-key\n");

    expect(loadEnvFile({ cwd })).toEqual({
      AI_MODEL: "from-env",
      OPENAI_API_KEY: "env-key",
    });
  });

  it("returns an empty object when .env is missing", () => {
    expect(loadEnvFile({ cwd: createTempDir() })).toEqual({});
  });

  it("loads a custom env file name", () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, ".env.test"), "AI_MODEL=from-custom-file\n");

    expect(loadEnvFile({ cwd, fileName: ".env.test" })).toEqual({
      AI_MODEL: "from-custom-file",
    });
  });

  it("loads an explicit env file path", () => {
    const cwd = createTempDir();
    const filePath = join(cwd, "global.env");
    writeFileSync(filePath, "AI_MODEL=from-explicit-path\n");

    expect(loadEnvFile({ filePath })).toEqual({
      AI_MODEL: "from-explicit-path",
    });
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yiku-env-"));
  tempDirs.push(dir);

  return dir;
}
