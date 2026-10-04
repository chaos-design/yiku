import { describe, expect, it } from "vitest";
import {
  CLI_WATCH_PACKAGE_PATHS,
  createWatchChangeReason,
  isRelevantWatchChange,
} from "../scripts/dev-watch-config.mjs";

describe("CLI dev watch configuration", () => {
  it("covers every package that contributes CLI runtime or Studio resources", () => {
    expect(CLI_WATCH_PACKAGE_PATHS).toEqual([
      "packages/cli",
      "packages/config",
      "packages/trajectory",
      "packages/hooks",
      "packages/atomic-flow",
      "packages/memories",
      "packages/evals",
      "packages/flow-graph",
      "packages/agents/code",
      "packages/agents/research",
      "packages/agent-orchestrator",
      "packages/agent-studio",
      "packages/agent-observatory",
    ]);
    expect(Object.isFrozen(CLI_WATCH_PACKAGE_PATHS)).toBe(true);
  });

  it.each([
    "src/index.ts",
    "src/app.tsx",
    "src/prompts/code.md",
    "src/data/config.json",
    "src/index.css",
    "src/template.html",
    "server/index.ts",
    "server/config.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "server/tsconfig.json",
    "index.html",
    "vite.config.ts",
  ])("rebuilds for %s", (fileName) => {
    expect(isRelevantWatchChange(fileName)).toBe(true);
  });

  it.each([
    "src/index.test.ts",
    "src/app.spec.tsx",
    "server/api-server.test.ts",
    "dist/index.js",
    "dist-server/index.js",
    "coverage/lcov.info",
    "README.md",
    "docs/architecture.md",
    "scripts/dev.mjs",
    "vite.config.js",
  ])("ignores %s", (fileName) => {
    expect(isRelevantWatchChange(fileName)).toBe(false);
  });

  it("normalizes platform paths and conservatively handles missing names", () => {
    expect(isRelevantWatchChange("src\\prompts\\code.md")).toBe(true);
    expect(isRelevantWatchChange(Buffer.from("server\\index.ts"))).toBe(true);
    expect(isRelevantWatchChange(undefined)).toBe(true);
    expect(isRelevantWatchChange(null)).toBe(true);
    expect(
      createWatchChangeReason("/repo", "/repo/packages/agent-observatory", "src\\index.css"),
    ).toBe("packages/agent-observatory/src/index.css");
    expect(createWatchChangeReason("/repo", "/repo/packages/cli", undefined)).toBe("packages/cli");
  });
});
