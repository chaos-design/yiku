import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionState } from "@yiku/agent-orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliSessionBootstrap, CliSessionState } from "../src/session-bootstrap.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CliSessionBootstrap", () => {
  it("loads merged config, environment, Skills, and Hook components", async () => {
    const directory = await temporaryDirectory();
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(homeDir, ".yiku"), { recursive: true });
    await mkdir(join(workspaceDir, ".yiku", "skills"), { recursive: true });
    await writeFile(
      join(homeDir, ".yiku", "config.yaml"),
      [
        "models:",
        "  default: default",
        "  items:",
        "    default:",
        "      name: gpt-test",
        "agents:",
        "  default: code",
        "  items:",
        "    code:",
        "      name: Code",
      ].join("\n"),
    );
    await writeFile(
      join(workspaceDir, "config.yaml"),
      [
        "agents:",
        "  items:",
        "    code:",
        "      skills: [code, tasks, review]",
        "      hookFrontmatter: |",
        "        ---",
        "        hooks: {}",
        "        ---",
        "runtime:",
        "  maxTurnsPerStage: 40",
        "flow:",
        "  trace: true",
        "skills:",
        "  items:",
        "    review:",
        "      instructions: .yiku/skills/review.md",
      ].join("\n"),
    );
    await writeFile(
      join(workspaceDir, ".yiku", "skills", "review.md"),
      ["---", "hooks: {}", "---", "Review carefully."].join("\n"),
    );
    await writeFile(join(workspaceDir, ".env"), "FILE_VALUE=from-file\n");

    const result = await new CliSessionBootstrap({
      cwd: workspaceDir,
      env: {
        FILE_VALUE: "from-option",
      },
      homeDir,
    }).load();

    expect(result.cwd).toBe(workspaceDir);
    expect(result.homeDir).toBe(homeDir);
    expect(result.environment.FILE_VALUE).toBe("from-option");
    expect(result.runtimeConfig.budget.maxTurnsPerStage).toBe(40);
    expect(result.runtimeConfig.flow.trace).toBe(true);
    expect(result.runtimeConfig.modelsConfig).toMatchObject({
      agents: {
        default: "code",
        items: {
          code: {
            name: "Code",
            skills: ["code", "tasks", "review"],
          },
        },
      },
    });
    expect(result.skillRegistry.resolveInstructions(["review"])).toBe("");
    expect(result.skillRegistry.resolvePromptSegments(["review"])).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Review carefully."),
        digest: createHash("sha256")
          .update(["---", "hooks: {}", "---", "Review carefully."].join("\n"))
          .digest("hex"),
        source: "skill",
        sourceId: "review",
        trust: "untrusted",
      }),
    ]);
    expect(result.hookComponents.map((component) => component.type)).toEqual(["agent", "skill"]);
  });

  it("lets the global ~/.yiku/.env override a conflicting workspace .env", async () => {
    const directory = await temporaryDirectory();
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(homeDir, ".yiku"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(homeDir, ".yiku", ".env"), "AI_API_KEY=from-home\nHOME_ONLY=home-value\n");
    await writeFile(
      join(workspaceDir, ".env"),
      "AI_API_KEY=REPLACE_WITH_YOUR_API_KEY\nWORKSPACE_ONLY=workspace-value\n",
    );

    const result = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir,
    }).load();

    expect(result.environment.AI_API_KEY).toBe("from-home");
    expect(result.environment.HOME_ONLY).toBe("home-value");
    expect(result.environment.WORKSPACE_ONLY).toBe("workspace-value");
  });

  it("discovers built-in, user, and project SKILL.md files into the runtime registry", async () => {
    const directory = await temporaryDirectory();
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await writeDiscoveredSkill(homeDir, "user-review", "User review.");
    await writeDiscoveredSkill(workspaceDir, "project-review", "Project review.");

    const result = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir,
    }).load();

    expect(result.skillRuntime.list().map((skill) => skill.name)).toEqual([
      "code-review",
      "find-skills",
      "implementation-planning",
      "project-review",
      "security-review",
      "skill-creator",
      "systematic-debugging",
      "test-driven-development",
      "user-review",
      "verification-before-completion",
    ]);
    expect(result.skillRuntime.inspect("code-review")).toMatchObject({
      source: "builtin",
      version: "1.0.0",
    });
    expect(result.skillRuntime.inspect("project-review")).toMatchObject({ source: "project" });
    expect(result.skillRuntime.inspect("user-review")).toMatchObject({ source: "user" });
    expect(result.skillRegistry.resolveInstructions(["project-review"])).toBe("");
    expect(result.skillRegistry.resolvePromptSegments(["project-review"])).toEqual([
      expect.objectContaining({
        digest: result.skillRuntime.inspect("project-review")?.digest,
        source: "skill",
        sourceId: "project-review",
        trust: "untrusted",
      }),
    ]);
    expect(result.skillRegistry.resolveInstructions(["user-review"])).toContain(
      "Instructions for user-review.",
    );
  });

  it("rejects a Skill that is both configured and discovered", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["skills:", "  items:", "    review:", "      mcp: []"].join("\n"),
    );
    await writeDiscoveredSkill(workspaceDir, "review", "Discovered review.");

    await expect(
      new CliSessionBootstrap({
        cwd: workspaceDir,
        homeDir: join(directory, "home"),
      }).load(),
    ).rejects.toThrow("Skill is both configured and discovered: review");
  });

  it("lets a configured Skill shadow a same-named built-in Skill", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["skills:", "  items:", "    code-review:", "      mcp: []"].join("\n"),
    );

    const result = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();

    expect(result.skillRegistry.get("code-review")).toMatchObject({ name: "code-review" });
    expect(result.skillRuntime.inspect("code-review")).toBeUndefined();
    expect(result.skillRuntime.shadowed()).toContainEqual(
      expect.objectContaining({ name: "code-review", source: "builtin" }),
    );
  });

  it("rejects Skill instruction paths outside the workspace", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["skills:", "  items:", "    outside:", "      instructions: ../outside.md"].join("\n"),
    );

    await expect(
      new CliSessionBootstrap({
        cwd: workspaceDir,
        homeDir: join(directory, "home"),
      }).load(),
    ).rejects.toThrow("Skill instruction path escapes the workspace");
  });

  it("discovers a healthy Web observer unless an endpoint is explicit", async () => {
    const directory = await temporaryDirectory();
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(homeDir, ".yiku"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(homeDir, ".yiku", "web.json"),
      JSON.stringify({
        endpoint: "http://127.0.0.1:3333",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        workspaceDir,
      }),
    );
    const request = vi.fn(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", request);

    const discovered = await new CliSessionBootstrap({
      cwd: workspaceDir,
      env: {
        YIKU_ATOMIC_STUDIO_URL: undefined,
      },
      homeDir,
    }).load();
    expect(discovered.environment.YIKU_ATOMIC_STUDIO_URL).toBe("http://127.0.0.1:3333");

    const explicit = await new CliSessionBootstrap({
      cwd: workspaceDir,
      env: {
        YIKU_ATOMIC_STUDIO_URL: "http://127.0.0.1:4444",
      },
      homeDir,
    }).load();
    expect(explicit.environment.YIKU_ATOMIC_STUDIO_URL).toBe("http://127.0.0.1:4444");
    expect(request).toHaveBeenCalledOnce();
  });

  it("assigns base and hash storage to canonical workspaces with the same readable name", async () => {
    const directory = await temporaryDirectory();
    const homeDir = join(directory, "home");
    const firstWorkspaceDir = join(directory, "one", "projects", "app");
    const secondWorkspaceDir = join(directory, "two", "projects", "app");
    await Promise.all(
      [firstWorkspaceDir, secondWorkspaceDir].map((workspaceDir) =>
        mkdir(workspaceDir, { recursive: true }),
      ),
    );

    const first = await new CliSessionBootstrap({
      cwd: firstWorkspaceDir,
      homeDir,
    }).load();
    const second = await new CliSessionBootstrap({
      cwd: secondWorkspaceDir,
      homeDir,
    }).load();

    const secondRealPath = await realpath(secondWorkspaceDir);
    const expectedHash = createHash("sha256").update(secondRealPath).digest("hex").slice(0, 8);
    expect(first.storage.storageName).toBe("projects_app");
    expect(second.storage.storageName).toBe(`projects_app_${expectedHash}`);
    expect(first.paths).toBe(first.storage.paths);
    expect(second.paths).toBe(second.storage.paths);
    expect(first.paths.sessionsDir).not.toBe(second.paths.sessionsDir);
  });

  it("creates and resumes durable Session state with a new budget epoch", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();
    const created = await new CliSessionState(bootstrap, {
      sessionId: "durable",
    }).open();

    expect(created.resumed).toBe(false);
    expect(created.state.sessionId).toBe("durable");
    const paused = await created.store.update(
      created.state.sessionId,
      created.state.revision,
      (state) => ({ ...state, status: "paused" }),
    );
    await created.store.close();

    const resumed = await new CliSessionState(bootstrap, {
      resumeSessionId: "durable",
    }).open();
    expect(resumed.resumed).toBe(true);
    expect(resumed.state).toMatchObject({
      budget: {
        epoch: paused.budget.epoch + 1,
        stage: 0,
      },
      status: "active",
    });
    await resumed.store.close();
  });

  it("preserves a Session epoch that was started before opening the resumed Runtime", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();
    const created = await new CliSessionState(bootstrap, {
      sessionId: "prestarted",
    }).open();
    const prestarted = await created.store.startEpoch(created.state.sessionId);
    await created.store.close();

    const resumed = await new CliSessionState(bootstrap, {
      resumeSessionId: "prestarted",
      resumeStartsEpoch: false,
    }).open();

    expect(resumed.state.budget.epoch).toBe(prestarted.budget.epoch);
    expect(resumed.state.status).toBe("active");
    await resumed.store.close();
  });

  it("preserves the epoch and record for a resumed pending question", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();
    const created = await new CliSessionState(bootstrap, {
      sessionId: "pending-question",
    }).open();
    const pending = await created.store.update(
      created.state.sessionId,
      created.state.revision,
      (state) =>
        parseSessionState({
          ...state,
          pendingInput: {
            kind: "question",
            questions: [
              {
                continuation: {
                  adapter: "openai-agents",
                  strategy: "reconstructed",
                },
                createdAt: "2026-08-20T00:00:00.000Z",
                questionId: "question-1",
                request: {
                  question: "Continue?",
                },
                stageId: "stage-1",
              },
            ],
          },
          status: "paused",
        }),
    );
    await created.store.close();

    const resumed = await new CliSessionState(bootstrap, {
      resumeSessionId: "pending-question",
    }).open();

    expect(resumed.state.budget.epoch).toBe(pending.budget.epoch);
    expect(resumed.state.pendingInput).toMatchObject({
      kind: "question",
      questions: [{ questionId: "question-1" }],
    });
    await resumed.store.close();
  });

  it("reports when the workspace has no unfinished Session", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();

    await expect(
      new CliSessionState(bootstrap, {
        continueSession: true,
      }).open(),
    ).rejects.toThrow("No unfinished Session exists");
  });

  it("registers instruction-free Skills and sanitizes explicit Session IDs", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["skills:", "  items:", "    plain: {}"].join("\n"),
    );
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();
    expect(bootstrap.skillRegistry.get("plain")).toMatchObject({ name: "plain" });

    const created = await new CliSessionState(bootstrap, {
      agentKey: "reviewer",
      modelKey: "explicit-model",
      sessionId: "bad/id",
    }).open();
    expect(created.state).toMatchObject({
      agentKey: "reviewer",
      modelKey: "explicit-model",
      sessionId: "bad-id",
    });
    await created.store.close();
  });

  it("preserves needs-review epochs and rejects completed resumes", async () => {
    const directory = await temporaryDirectory();
    const workspaceDir = join(directory, "workspace");
    const sessionsDir = join(directory, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    const bootstrap = await new CliSessionBootstrap({
      cwd: workspaceDir,
      homeDir: join(directory, "home"),
    }).load();
    const review = await new CliSessionState(bootstrap, {
      sessionId: "review",
      sessionsDir,
    }).open();
    const needsReview = await review.store.update(
      review.state.sessionId,
      review.state.revision,
      (state) => ({ ...state, status: "needs-review" }),
    );
    await review.store.close();

    const resumed = await new CliSessionState(bootstrap, {
      resumeSessionId: "review",
      sessionsDir,
    }).open();
    expect(resumed.state.budget.epoch).toBe(needsReview.budget.epoch);
    await resumed.store.close();

    const completed = await new CliSessionState(bootstrap, {
      sessionId: "completed",
      sessionsDir,
    }).open();
    await completed.store.update(completed.state.sessionId, completed.state.revision, (state) => ({
      ...state,
      status: "completed",
    }));
    await completed.store.close();
    await expect(
      new CliSessionState(bootstrap, {
        resumeSessionId: "completed",
        sessionsDir,
      }).open(),
    ).rejects.toThrow("cannot be resumed from status completed");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-session-bootstrap-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeDiscoveredSkill(
  root: string,
  name: string,
  description: string,
): Promise<void> {
  const directory = join(root, ".yiku", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "version: 1.0.0",
      "---",
      "",
      `Instructions for ${name}.`,
    ].join("\n"),
  );
}
