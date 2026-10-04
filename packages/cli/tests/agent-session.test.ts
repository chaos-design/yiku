import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultSkillRegistry,
  type McpConnection,
  type McpConnectionFactory,
} from "@yiku/agent-orchestrator";
import { YikuPaths } from "@yiku/config";
import { describe, expect, it, vi } from "vitest";
import { CliAgentSession, executeAgentSession } from "../src/agent-session.js";
import { PermissionProfileStore } from "../src/permission/profile-store.js";

describe("executeAgentSession", () => {
  it("delegates agent execution to the orchestrator package", async () => {
    const abortController = new AbortController();
    const onContext = vi.fn();
    const onEvent = vi.fn();
    const permissionApprovalHandler = vi.fn(() => ({ decision: "deny" as const }));
    const runAgentSessionImpl = vi.fn(async () => "agent result");

    await expect(
      executeAgentSession("review this", {
        agentKey: "code",
        cwd: "/workspace",
        env: {
          OPENAI_API_KEY: "test-key",
        },
        modelKey: "gpt-test",
        modelsConfig: {},
        onContext,
        onEvent,
        permissionApprovalHandler,
        runAgentSessionImpl,
        sessionId: "session-1",
        sessionsDir: "/workspace/.yiku/sessions",
        signal: abortController.signal,
      }),
    ).resolves.toBe("agent result");

    expect(runAgentSessionImpl).toHaveBeenCalledWith("review this", {
      agentKey: "code",
      cwd: "/workspace",
      env: {
        OPENAI_API_KEY: "test-key",
      },
      modelKey: "gpt-test",
      modelsConfig: {},
      onContext,
      onEvent,
      permissionApprovalHandler,
      sessionId: "session-1",
      sessionsDir: "/workspace/.yiku/sessions",
      signal: abortController.signal,
    });
  });

  it("delegates with minimal options", async () => {
    const runAgentSessionImpl = vi.fn(async () => "agent result");

    await expect(
      executeAgentSession("review this", {
        runAgentSessionImpl,
      }),
    ).resolves.toBe("agent result");

    expect(runAgentSessionImpl).toHaveBeenCalledWith("review this", {});
  });
});

describe("CliAgentSession", () => {
  it("injects only the CLI Yiku directory as an additional filesystem root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-filesystem-roots-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    const ignoredRoot = join(directory, "ignored");
    await mkdir(workspaceDir);
    await mkdir(ignoredRoot);
    const turnRunner = vi.fn(async (_prompt, options) => {
      expect(options.additionalFileSystemRoots).toEqual([join(homeDir, ".yiku")]);
      expect(options.homeDir).toBe(homeDir);
      return "done";
    });
    const session = new CliAgentSession({
      additionalFileSystemRoots: [ignoredRoot],
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      sessionId: "filesystem-roots",
      turnRunner,
    });

    try {
      await expect(session.submit("inspect roots")).resolves.toBe("done");
      expect(turnRunner).toHaveBeenCalledOnce();
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("manages durable Session state operations after ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-session-ops-"));
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      env: {
        OPENAI_API_KEY: "test-key",
      },
      homeDir: join(directory, "home"),
      modelsConfig: {
        models: {
          default: "code",
          items: {
            bare: null,
            code: { contextWindow: 128_000, name: "gpt-code", provider: "openai" },
            invalid: { baseURL: "::" },
            next: { baseURL: "https://api.example.test/v1", name: "gpt-next" },
          },
        },
      },
      sessionId: "session-ops",
      turnRunner: async () => "assistant response",
    });

    try {
      await session.ready();
      await expect(session.currentModel()).resolves.toBe("code");
      await expect(session.models()).resolves.toEqual([
        { key: "bare", model: "bare" },
        {
          contextWindow: 128_000,
          contextWindowSource: "configured",
          key: "code",
          model: "gpt-code",
          provider: "openai",
        },
        { key: "invalid", model: "invalid" },
        { key: "next", model: "gpt-next", provider: "api.example.test" },
      ]);
      await expect(session.outputStyle()).resolves.toBe("default");
      await expect(session.mcpStatus()).resolves.toEqual([]);
      await expect(session.reconnectMcp("missing")).rejects.toThrow(
        "No MCP servers are configured",
      );
      await expect(session.setCurrentModel("missing")).rejects.toThrow("Model is not configured");
      await expect(session.setCurrentModel("")).rejects.toThrow("(empty)");
      await expect(session.setGlobalModel("missing")).rejects.toThrow("Model is not configured");
      await expect(session.stateSnapshot()).resolves.toMatchObject({
        sessionId: "session-ops",
        workspaceDir: directory,
      });
      await expect(session.listSessions()).resolves.toHaveLength(1);
      await expect(session.renameCurrent("Renamed Session")).resolves.toMatchObject({
        sessionId: "session-ops",
        title: "Renamed Session",
      });
      await expect(session.submit("export prompt")).resolves.toBe("assistant response");
      const exported = await session.exportSession();
      expect(await readFile(exported.filePath, "utf8")).toContain("Title: Renamed Session");
      expect(await readFile(exported.filePath, "utf8")).toContain("## Checkpoint: created");
      await expect(session.exportSession("reports/session.md")).resolves.toMatchObject({
        filePath: join(directory, "reports", "session.md"),
      });

      await expect(session.setCurrentModel("next")).resolves.toMatchObject({
        modelKey: "next",
      });
      await expect(session.currentModel()).resolves.toBe("next");
      await expect(session.setOutputStyle("verbose")).resolves.toMatchObject({
        outputStyle: "verbose",
      });
      await expect(session.outputStyle()).resolves.toBe("verbose");
      await session.setGlobalModel("next");
      expect(await readFile(join(directory, "home", ".yiku", "config.yaml"), "utf8")).toContain(
        "default: next",
      );

      const generatedClone = await session.cloneCurrent();
      expect(generatedClone.sessionId).not.toBe("session-ops");
      await session.removeSession(generatedClone.sessionId);

      await expect(
        session.cloneCurrent({ sessionId: "session-branch", title: "Branch" }),
      ).resolves.toMatchObject({
        sessionId: "session-branch",
        title: "Branch",
      });
      await expect(
        session.renameSession("session-branch", "Renamed Branch"),
      ).resolves.toMatchObject({
        title: "Renamed Branch",
      });
      await expect(session.startSessionEpoch("session-branch")).resolves.toMatchObject({
        sessionId: "session-branch",
        status: "active",
      });
      expect((await session.listSessions()).map((state) => state.sessionId)).toEqual([
        "session-branch",
        "session-ops",
      ]);
      await session.removeSession("session-branch");
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }

    await expect(session.stateSnapshot()).resolves.toBeUndefined();
    await expect(session.listSessions()).rejects.toThrow("durable state is unavailable");
  });

  it("keeps legacy runner lifecycle methods compatible", async () => {
    const runAgentSessionImpl = vi.fn(async () => "legacy");
    const session = new CliAgentSession({ runAgentSessionImpl });

    await expect(session.hooks()).resolves.toBeUndefined();
    await expect(session.currentModel()).resolves.toBeUndefined();
    await expect(session.models()).resolves.toEqual([]);
    await expect(session.outputStyle()).resolves.toBe("default");
    await expect(session.mcpStatus()).resolves.toEqual([]);
    await expect(session.clear()).resolves.toBeUndefined();
    await expect(session.checkpoints()).resolves.toEqual([]);
    await expect(session.submit("legacy prompt")).resolves.toBe("legacy");
    await expect(session.createSkill("create one")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.installSkill("owner/repository")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    expect(session.pendingUserQuestions()).toEqual([]);
    expect(() => session.answerUserQuestion("missing", { answer: "none" })).toThrow(
      "does not have an active Runtime",
    );
    expect(() => session.cancelUserQuestion("missing")).toThrow("does not have an active Runtime");
    await expect(session.rewind("missing")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.setCurrentModel("model")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.setGlobalModel("model")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.setOutputStyle("compact")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.reconnectMcp("server")).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.exportSession()).rejects.toThrow(
      "unavailable for an injected Agent Session",
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(runAgentSessionImpl).toHaveBeenCalledWith("legacy prompt", {});
  });

  it("forwards Runtime submission options into the persistent Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-skill-submit-"));
    const turnRunner = vi.fn(async () => "reviewed");
    const skillRegistry = new DefaultSkillRegistry();
    skillRegistry.register({
      description: "Review changes.",
      instructions: "Review current changes.",
      name: "review",
      path: join(directory, ".yiku", "skills", "review", "SKILL.md"),
    });
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      env: { OPENAI_API_KEY: "test-key" },
      homeDir: join(directory, "home"),
      modelsConfig: { models: { default: "code" } },
      sessionId: "skill-submit",
      skillRegistry,
      turnRunner,
    });

    try {
      await expect(
        session.submit("focus tests", {
          activatedSkills: ["review"],
          commandArgs: "focus tests",
          commandName: "review",
          continuationState: { marker: "cli-continuation" } as never,
        }),
      ).resolves.toBe("reviewed");
      expect(turnRunner).toHaveBeenCalledWith(
        "focus tests",
        expect.objectContaining({
          activatedSkills: ["review"],
          commandArgs: "focus tests",
          commandName: "review",
          continuationState: { marker: "cli-continuation" },
        }),
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports the environment-resolved provider model name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-model-display-"));
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      env: {
        AI_MODEL_NAME: "runtime-model",
        OPENAI_API_KEY: "test-key",
      },
      homeDir: join(directory, "home"),
      modelsConfig: {
        models: {
          default: "code",
          items: {
            code: { name: "configured-model" },
          },
        },
      },
      sessionId: "model-display",
      turnRunner: async () => "done",
    });

    try {
      await expect(session.models()).resolves.toEqual([{ key: "code", model: "runtime-model" }]);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports env-only model context before the first submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-env-model-display-"));
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      env: {
        AI_CONTEXT_WINDOW: "1000000",
        AI_MODEL_NAME: "ep-20260811165143-7vrw5",
        OPENAI_API_KEY: "test-key",
      },
      homeDir: join(directory, "home"),
      modelsConfig: {},
      sessionId: "env-model-display",
      turnRunner: async () => "done",
    });

    try {
      await expect(session.currentModel()).resolves.toBe("ep-20260811165143-7vrw5");
      await expect(session.models()).resolves.toEqual([
        {
          contextWindow: 1_000_000,
          contextWindowSource: "configured",
          key: "ep-20260811165143-7vrw5",
          model: "ep-20260811165143-7vrw5",
        },
      ]);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reuses one persistent session and flushes complete display segments in order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-session-"));
    const turnRunner = vi.fn(async (_prompt, options) => {
      options.onEvent?.({ text: "hello ", type: "message_delta" });
      options.onEvent?.({ text: "world", type: "message_delta" });
      return "hello world";
    });
    const onEvent = vi.fn();
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      homeDir: join(directory, "home"),
      sessionId: "persistent",
      turnRunner,
    });

    try {
      await expect(session.submit("first", { onEvent })).resolves.toBe("hello world");
      await expect(session.submit("second", { onEvent })).resolves.toBe("hello world");

      expect(turnRunner).toHaveBeenCalledTimes(2);
      expect(
        onEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.type === "message_delta"),
      ).toEqual([
        { text: "hello world", type: "message_delta" },
        { text: "hello world", type: "message_delta" },
      ]);
      expect(turnRunner.mock.calls[1]?.[1].promptSegments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("first"),
            kind: "history",
            trust: "untrusted",
          }),
        ]),
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("forwards message callbacks to the persistent Session Runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-message-"));
    const onMessage = vi.fn();
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      homeDir: join(directory, "home"),
      sessionId: "message-session",
      turnRunner: async (_prompt, options) => {
        options.onEvent?.({ text: "child output", type: "message_delta" });
        return "child output";
      },
    });

    try {
      await expect(session.submit("delegate", { onMessage })).resolves.toBe("child output");
      expect(onMessage.mock.calls.map(([message]) => message.payload.kind)).toContain(
        "assistant_delta",
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists workspace checkpoints and forwards rewind to the Runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-checkpoint-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    const filePath = join(workspaceDir, "tracked.txt");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(filePath, "before\n");
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      sessionId: "checkpoint-session",
      turnRunner: async () => {
        await writeFile(filePath, "after\n");
        return "changed";
      },
    });

    try {
      await expect(session.submit("change the file")).resolves.toBe("changed");
      await expect(readFile(filePath, "utf8")).resolves.toBe("after\n");
      const checkpoints = await session.checkpoints();
      expect(checkpoints).toEqual([
        expect.objectContaining({
          historyEntries: [],
          prompt: "change the file",
        }),
      ]);

      await session.rewind(checkpoints[0]?.id ?? "");

      await expect(readFile(filePath, "utf8")).resolves.toBe("before\n");
      const paths = new YikuPaths({ homeDir, workspaceDir });
      expect(existsSync(join(paths.sessionsDir, "checkpoint-session.checkpoints.json"))).toBe(true);
      expect(existsSync(join(paths.workspaceStorageDir, "checkpoints", "manifests"))).toBe(true);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("answers a Runtime user question without starting another submit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-question-"));
    const events: Array<{ readonly type: string }> = [];
    const turnRunner = vi.fn(async (_prompt, options) => {
      const response = await options.userQuestionHandler?.({
        options: ["PostgreSQL", "SQLite"],
        question: "Which database should we use?",
      });
      return `selected ${response?.answer ?? "missing"}`;
    });
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      homeDir: join(directory, "home"),
      sessionId: "question-session",
      turnRunner,
    });

    try {
      const submitting = session.submit("design storage", {
        onEvent: (event) => events.push(event),
      });
      await vi.waitFor(() => {
        expect(session.pendingUserQuestions()).toHaveLength(1);
      });
      const questionId = session.pendingUserQuestions()[0]?.questionId ?? "";
      session.answerUserQuestion(questionId, {
        answer: "SQLite",
        selectedIndex: 1,
      });

      await expect(submitting).resolves.toBe("selected SQLite");
      expect(turnRunner).toHaveBeenCalledOnce();
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["user_question_requested", "user_question_resolved"]),
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("discovers Yiku Hooks, ignores Claude settings, and fails closed without trust", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-hooks-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(join(workspaceDir, ".claude"), { recursive: true });
    await mkdir(join(homeDir, ".yiku"), { recursive: true });
    await writeFile(
      join(homeDir, ".yiku", "config.yaml"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "echo global", type: "command" }] }],
        },
      }),
    );
    await writeFile(
      join(workspaceDir, "config.yaml"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ command: "echo trusted", type: "command" }],
            },
          ],
        },
      }),
    );
    await writeFile(
      join(workspaceDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "echo ignored", type: "command" }] }],
        },
      }),
    );
    const turnRunner = vi.fn(async () => "not called");
    const session = new CliAgentSession({
      cwd: workspaceDir,
      homeDir,
      turnRunner,
    });

    try {
      const controller = await session.hooks();
      await expect(controller?.list()).resolves.toEqual([
        expect.objectContaining({ sourceType: "user" }),
        expect.objectContaining({ sourceType: "project" }),
      ]);
      await expect(session.submit("blocked")).rejects.toThrow("pre-authorization");
      expect(turnRunner).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("closes cleanly when an untrusted SessionEnd Hook is not pre-authorized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-session-end-hook-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [{ command: "echo closing", type: "command" }],
            },
          ],
        },
      }),
    );
    const turnRunner = vi.fn(async () => "done");
    const session = new CliAgentSession({
      cwd: workspaceDir,
      homeDir,
      turnRunner,
    });

    try {
      await expect(session.submit("run")).resolves.toBe("done");
      await expect(session.close()).resolves.toBeUndefined();
      expect(turnRunner).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("connects configured MCP servers after trust and exposes them to the Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-mcp-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      [
        "agents:",
        "  items:",
        "    code:",
        "      skills: [code, tasks, policy]",
        "skills:",
        "  items:",
        "    policy:",
        "      mcp: [policy/evaluate]",
        "mcp:",
        "  servers:",
        "    policy:",
        "      transport: stdio",
        "      command: policy-server",
        "      tools: [evaluate]",
      ].join("\n"),
    );
    const connection: McpConnection = {
      close: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      invoke: vi.fn(async () => ({ ok: true })),
      listTools: vi.fn(async () => [
        {
          inputSchema: { properties: {}, type: "object" },
          name: "evaluate",
        },
      ]),
      name: "policy",
    };
    const mcpServerFactory: McpConnectionFactory = {
      create: vi.fn(() => connection),
    };
    const trust = vi.fn(async () => ({ decision: "allow" as const }));
    const turnRunner = vi.fn(async (_prompt, options) => {
      expect(options.mcpSkillTargets).toEqual({
        policy: ["policy/evaluate"],
      });
      await expect(options.mcpRegistry?.listTools()).resolves.toHaveLength(1);
      return "mcp ready";
    });
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      mcpServerFactory,
      sessionId: "mcp-session",
      turnRunner,
    });

    try {
      await expect(
        session.submit("use policy", {
          hookTrustApprovalHandler: trust,
        }),
      ).resolves.toBe("mcp ready");
      expect(trust).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "mcp:stdio:policy-server",
          executorType: "mcp",
        }),
      );
      expect(connection.connect).toHaveBeenCalledOnce();
      await expect(session.mcpStatus()).resolves.toEqual([
        expect.objectContaining({
          name: "policy",
          status: "connected",
          toolCount: 1,
        }),
      ]);
      await expect(session.reconnectMcp("policy")).resolves.toBeUndefined();
      expect(connection.connect).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
      expect(connection.close).toHaveBeenCalledTimes(2);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("opens project SQLite Memories only when enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-memory-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["memory:", "  enabled: true", "  extraction: false", "  failureMode: best-effort"].join(
        "\n",
      ),
    );
    const turnRunner = vi.fn(async (_prompt, options) => {
      const memories = options.memories;
      expect(memories).toBeDefined();
      if (memories !== undefined) {
        await memories.manager.remember({
          content: "Use pnpm",
          context: memories.context,
          kind: "procedure",
        });
      }
      return "remembered";
    });
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      sessionId: "memory-session",
      turnRunner,
    });

    try {
      await expect(session.submit("remember this")).resolves.toBe("remembered");
      expect(existsSync(new YikuPaths({ homeDir, workspaceDir }).workspaceMemoryFilePath)).toBe(
        true,
      );
      expect(existsSync(join(workspaceDir, ".yiku", "memories.sqlite"))).toBe(false);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps read-only Session and Memory files outside the workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-read-only-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(join(workspaceDir, ".env"), "YIKU_SESSIONS_DIR=.yiku/leaked-sessions\n");
    await writeFile(
      join(workspaceDir, "config.yaml"),
      ["memory:", "  enabled: true", "  extraction: false"].join("\n"),
    );
    const session = new CliAgentSession({
      accessMode: "read-only",
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      sessionId: "read-only-session",
      turnRunner: async (_prompt, options) => {
        await options.memories?.manager.remember({
          content: "Read-only memory",
          context: options.memories.context,
          kind: "fact",
        });
        return "done";
      },
    });

    try {
      await expect(session.submit("inspect")).resolves.toBe("done");
      const runtimeRoot = new YikuPaths({ homeDir, workspaceDir }).workspaceStorageDir;

      expect(existsSync(join(runtimeRoot, "session", "read-only-session.state.json"))).toBe(true);
      expect(existsSync(join(runtimeRoot, "session", "read-only-session.jsonl"))).toBe(true);
      expect(existsSync(join(runtimeRoot, "session", "read-only-session.transcript.jsonl"))).toBe(
        true,
      );
      expect(existsSync(join(runtimeRoot, "memory", "memories.sqlite"))).toBe(true);
      expect(existsSync(join(workspaceDir, ".yiku", "leaked-sessions"))).toBe(false);
      expect(existsSync(join(workspaceDir, ".yiku", "memories.sqlite"))).toBe(false);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retries MCP connection after a transient failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-mcp-retry-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      [
        "agents:",
        "  items:",
        "    code:",
        "      skills: [policy]",
        "skills:",
        "  items:",
        "    policy:",
        "      mcp: [policy/evaluate]",
        "mcp:",
        "  servers:",
        "    policy:",
        "      transport: stdio",
        "      command: policy-server",
      ].join("\n"),
    );
    const connection: McpConnection = {
      close: vi.fn(async () => undefined),
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(undefined),
      invoke: vi.fn(),
      listTools: vi.fn(async () => []),
      name: "policy",
    };
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      mcpServerFactory: {
        create: () => connection,
      },
      turnRunner: async () => "connected",
    });
    const submitOptions = {
      hookTrustApprovalHandler: async () => ({ decision: "allow" as const }),
    };

    try {
      await expect(session.submit("first", submitOptions)).rejects.toThrow("temporary failure");
      await expect(session.submit("second", submitOptions)).resolves.toBe("connected");
      expect(connection.connect).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("forwards non-message events and presents output when no delta was emitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-events-"));
    const onEvent = vi.fn();
    const onContext = vi.fn();
    const permissionApprovalHandler = vi.fn();
    const signal = new AbortController().signal;
    const userQuestionHandler = vi.fn(async () => ({ answer: "Continue" }));
    const session = new CliAgentSession({
      cwd: directory,
      discoverHooks: false,
      homeDir: join(directory, "home"),
      turnRunner: async (_prompt, options) => {
        await expect(options.userQuestionHandler?.({ question: "Continue?" })).resolves.toEqual({
          answer: "Continue",
        });
        options.onEvent?.({ agentName: "Code Agent", type: "agent_updated" });
        return "final output";
      },
    });

    try {
      await expect(
        session.submit("events", {
          onContext,
          onEvent,
          permissionApprovalHandler,
          signal,
          userQuestionHandler,
        }),
      ).resolves.toBe("final output");
      expect(onEvent).toHaveBeenCalledWith({
        agentName: "Code Agent",
        type: "agent_updated",
      });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user_question_requested",
        }),
      );
      expect(userQuestionHandler).toHaveBeenCalledOnce();
      await expect(session.hooks()).resolves.toBeUndefined();
      await session.clear();
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses an interactive trust handler and resolves model executor configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-trusted-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ command: "printf trusted-context", type: "command" }],
            },
          ],
        },
      }),
    );
    const approval = vi.fn(() => ({ decision: "allow" as const }));
    const session = new CliAgentSession({
      cwd: workspaceDir,
      env: {
        AI_BASE_URL: "https://api.example.test/v1",
        AI_MODEL: "test-model",
        OPENAI_API_KEY: "test-key",
      },
      homeDir,
      modelKey: "test-model",
      turnRunner: async () => "trusted output",
    });

    try {
      await expect(session.submit("trusted", { hookTrustApprovalHandler: approval })).resolves.toBe(
        "trusted output",
      );
      expect(approval).toHaveBeenCalledOnce();
      const atomicRunsDir = new YikuPaths({ homeDir, workspaceDir }).atomicRunsDir;
      const [runDirectory] = await readdir(atomicRunsDir);
      const atomicEvents = (
        await readFile(join(atomicRunsDir, runDirectory ?? "", "flow.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly atom: { readonly key: string } });
      expect(atomicEvents.map((event) => event.atom.key)).toEqual(
        expect.arrayContaining(["hook.dispatch", "hook.execute"]),
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses interactive Hook trust while compacting context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-compact-hook-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(join(workspaceDir, ".yiku"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(workspaceDir, "config.yaml"),
      JSON.stringify({
        hooks: {
          PreCompact: [
            {
              hooks: [{ command: "printf '{}'", type: "command" }],
            },
          ],
        },
      }),
    );
    const approval = vi.fn(() => ({ decision: "allow" as const, scope: "once" as const }));
    const session = new CliAgentSession({
      contextSummarizer: {
        summarize: async () => "compacted summary",
      },
      cwd: workspaceDir,
      homeDir,
      turnRunner: async () => "done",
    });

    try {
      await session.submit("seed context");
      await expect(
        session.compact("preserve decisions", {
          hookTrustApprovalHandler: approval,
        }),
      ).resolves.toBeUndefined();
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "PreCompact",
          source: expect.objectContaining({
            path: join(workspaceDir, "config.yaml"),
            type: "project",
          }),
        }),
      );
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("allows configured policies and persists a user-approved policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-permission-profile-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const profileStore = new PermissionProfileStore({ homeDir });
    await profileStore.setPolicyRule("configured-policy", "allow");
    await profileStore.setPolicyRule("denied-policy", "deny");
    const document = await profileStore.load();
    const profile = document.profiles.default;
    if (profile === undefined) {
      throw new Error("Expected default permission profile.");
    }
    await writeFile(
      profileStore.filePath,
      JSON.stringify({
        ...document,
        profiles: {
          ...document.profiles,
          default: {
            ...profile,
            approval: {
              ...profile.approval,
              commandRules: { "command-allowed": "allow" },
              mcpRules: { "github/delete_*": "deny" },
            },
          },
        },
      }),
    );
    const userApproval = vi.fn(async () => ({
      decision: "allow" as const,
      scope: "persistent" as const,
    }));
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      turnRunner: async (policyId, options) => {
        const mcpRequest = policyId === "mcp-request";
        const response = await options.permissionApprovalHandler?.({
          action: mcpRequest ? "invoke MCP tool" : "execute command",
          capabilities: mcpRequest ? ["external.mcp.invoke"] : ["process.execute"],
          normalizedAction: mcpRequest ? "invoke external MCP tool" : "execute test command",
          policyId: mcpRequest ? "mcp-external-side-effect" : policyId,
          reason: "test",
          risk: "medium",
          subject: mcpRequest ? "github/delete_repository" : policyId,
          toolName: mcpRequest ? "github/delete_repository" : "bashTool",
          workspaceId: "workspace-1",
        });
        return response?.decision ?? "missing";
      },
    });

    try {
      await expect(
        session.submit("configured-policy", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).not.toHaveBeenCalled();

      await expect(
        session.submit("denied-policy", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("deny");
      expect(userApproval).not.toHaveBeenCalled();

      await expect(session.submit("unconfigured-policy")).resolves.toBe("deny");

      await expect(session.submit("command-allowed")).resolves.toBe("allow");
      await expect(
        session.submit("mcp-request", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("deny");
      expect(userApproval).not.toHaveBeenCalled();

      await expect(
        session.submit("remember-policy", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledOnce();

      await expect(session.submit("remember-policy")).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledOnce();
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reuses matching Session permission grants and asks for different permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-session-permissions-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const userApproval = vi.fn(async () => ({
      decision: "allow" as const,
      scope: "session" as const,
    }));
    let requestSequence = 0;
    const request = (subject: string, truncated = false) => ({
      action: "execute command",
      capabilities: ["process.execute", "workspace.delete"],
      ...(truncated ? { metadata: { commandTruncated: "true" } } : {}),
      normalizedAction: "recursively force-remove workspace paths",
      policyId: "recursive-force-rm",
      reason: "recursively force-removes files or directories",
      risk: "high" as const,
      subject,
      toolCallId: `tool-call-${++requestSequence}`,
      toolName: "bashTool",
      workspaceId: "workspace-1",
    });
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      turnRunner: async (prompt, options) => {
        const approval = options.permissionApprovalHandler;
        if (approval === undefined) {
          return "missing";
        }
        if (prompt === "concurrent") {
          const responses = await Promise.all([
            approval(request("rm -rf cache")),
            approval(request("rm -rf cache")),
          ]);
          return responses.map((response) => response.decision).join(",");
        }
        const response = await approval(
          request(
            prompt === "different" ? "rm -rf dist" : "rm -rf build",
            prompt.startsWith("truncated"),
          ),
        );
        return response.decision;
      },
    });

    try {
      await expect(
        session.submit("first", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      await expect(session.submit("repeat")).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledOnce();

      await expect(
        session.submit("different", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledTimes(2);

      await expect(
        session.submit("concurrent", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow,allow");
      expect(userApproval).toHaveBeenCalledTimes(3);

      await expect(
        session.submit("truncated-first", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      await expect(
        session.submit("truncated-repeat", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledTimes(5);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies Permission Profile rules to runtime-allowed Shell commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-permission-assessment-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await new PermissionProfileStore({ homeDir }).setPolicyRule("known-low-risk-command", "ask");
    const userApproval = vi.fn(async () => ({
      decision: "allow" as const,
      scope: "once" as const,
    }));
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      homeDir,
      turnRunner: async (prompt, options) => {
        const request = {
          action: "execute command",
          capabilities: ["process.execute"],
          normalizedAction: "execute classified workspace command",
          policyId:
            prompt === "configured-read" ? "known-low-risk-command" : "runtime-default-allow",
          reason: "matches the low-risk shell command allowlist",
          risk: "low" as const,
          subject: "cat README.md",
          toolName: "bashTool",
          workspaceId: "workspace-1",
        };
        const assessment =
          (await options.permissionAssessmentHandler?.(request, "allow")) ?? "allow";
        if (assessment !== "ask") {
          return assessment;
        }
        return (await options.permissionApprovalHandler?.(request))?.decision ?? "deny";
      },
    });

    try {
      await expect(
        session.submit("configured-read", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledOnce();

      await expect(
        session.submit("runtime-default", { permissionApprovalHandler: userApproval }),
      ).resolves.toBe("allow");
      expect(userApproval).toHaveBeenCalledOnce();
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs legacy config and runtime migration only when explicitly enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-legacy-migration-"));
    const homeDir = join(directory, "home");
    const workspaceDir = join(directory, "workspace");
    const legacySessionsDir = join(workspaceDir, ".yiku", "sessions");
    await mkdir(legacySessionsDir, { recursive: true });
    await writeFile(join(legacySessionsDir, "legacy.jsonl"), "{}\n");
    await writeFile(join(workspaceDir, ".yiku", "config.yaml"), "memory:\n  enabled: false\n");
    const session = new CliAgentSession({
      cwd: workspaceDir,
      discoverHooks: false,
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
      },
      homeDir,
      migrateLegacy: true,
      turnRunner: async () => "migrated",
    });

    try {
      await expect(session.submit("migrate")).resolves.toBe("migrated");
      const paths = new YikuPaths({ homeDir, workspaceDir });
      expect(existsSync(join(paths.sessionsDir, "legacy.jsonl"))).toBe(true);
      expect(existsSync(legacySessionsDir)).toBe(false);
      expect(existsSync(join(workspaceDir, "config.yaml"))).toBe(true);
    } finally {
      await session.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("closes without initializing when no work was submitted", async () => {
    await expect(new CliAgentSession().close()).resolves.toBeUndefined();
  });
});
