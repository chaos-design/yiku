import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgentWorkspaceScopes } from "../../src/workspace/agent-scope-discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("discoverAgentWorkspaceScopes", () => {
  it("discovers and bounds monorepo package scopes", async () => {
    const workspace = await temporaryDirectory();
    await packageFixture(workspace, "packages/agent-observatory", {
      dependencies: { react: "^19.0.0" },
      name: "@yiku/agent-observatory",
    });
    await packageFixture(workspace, "packages/agent-orchestrator", {
      description: "Agent runtime",
      name: "@yiku/agent-orchestrator",
    });
    await packageFixture(workspace, "packages/z-last", {
      name: "@yiku/z-last",
    });
    await mkdir(join(workspace, "docs"));

    await expect(discoverAgentWorkspaceScopes(workspace)).resolves.toEqual([
      {
        description: "packages/agent-observatory package",
        label: "前端 agent-observatory",
        path: "packages/agent-observatory",
      },
      {
        description: "Agent runtime",
        label: "agent-orchestrator",
        path: "packages/agent-orchestrator",
      },
      {
        description: "架构、API 与项目文档",
        label: "文档 docs/",
        path: "docs",
      },
      {
        description: "覆盖当前 workspace 的全部代码与文档",
        label: "整个工作区",
        path: ".",
      },
    ]);
  });

  it("falls back to source roots and the whole workspace", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, "src"));

    await expect(discoverAgentWorkspaceScopes(workspace)).resolves.toEqual([
      {
        description: "src/ source tree",
        label: "src",
        path: "src",
      },
      {
        description: "覆盖当前 workspace 的全部代码与文档",
        label: "整个工作区",
        path: ".",
      },
    ]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-agent-scopes-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function packageFixture(
  workspace: string,
  path: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const directory = join(workspace, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
}
