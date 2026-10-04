import { createInitialSessionState, type SessionState } from "@yiku/agent-orchestrator";
import { describe, expect, it, vi } from "vitest";
import type {
  CliAgentSession,
  CliAgentSessionContract,
  CliAgentSessionSubmitOptions,
} from "../src/agent-session.js";
import { CliSessionController } from "../src/session-controller.js";

describe("CliSessionController", () => {
  it("switches in strict order and starts a new epoch for a finished Session", async () => {
    const order: string[] = [];
    const listedState = sessionState("target", "completed");
    const replayState = sessionState("target");
    const source = sessionDouble({
      close: vi.fn(async (reason) => {
        order.push(`source:close:${reason}`);
      }),
      listSessions: vi.fn(async () => {
        order.push("source:list");
        return [listedState];
      }),
      startSessionEpoch: vi.fn(async (id) => {
        order.push(`source:epoch:${id}`);
        return sessionState(id);
      }),
    });
    const target = sessionDouble({
      ready: vi.fn(async () => {
        order.push("target:ready");
      }),
      stateSnapshot: vi.fn(async () => {
        order.push("target:snapshot");
        return replayState;
      }),
    });
    const controller = new CliSessionController({
      createSession: (sessionId, options) => {
        order.push(`create:${sessionId}:${options?.resumeStartsEpoch}`);
        return target;
      },
      initialSession: source,
      onInputEnabled: (enabled) => {
        order.push(`input:${enabled}`);
      },
      onTimelineReplay: (state) => {
        order.push(`replay:${state?.sessionId}`);
      },
    });

    await controller.switch("target");

    expect(order).toEqual([
      "input:false",
      "source:list",
      "source:epoch:target",
      "create:target:false",
      "target:ready",
      "source:close:resume",
      "target:snapshot",
      "replay:target",
      "input:true",
    ]);
  });

  it("serializes concurrent switches", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const states = [sessionState("first"), sessionState("second")];
    const source = sessionDouble({
      close: vi.fn(async () => {
        order.push("source:close");
      }),
      listSessions: vi.fn(async () => {
        order.push("source:list");
        return states;
      }),
    });
    const first = sessionDouble({
      close: vi.fn(async () => {
        order.push("first:close");
      }),
      listSessions: vi.fn(async () => {
        order.push("first:list");
        return states;
      }),
      ready: vi.fn(async () => {
        order.push("first:ready");
        await firstReady;
      }),
    });
    const second = sessionDouble({
      ready: vi.fn(async () => {
        order.push("second:ready");
      }),
    });
    const controller = new CliSessionController({
      createSession: (sessionId) => (sessionId === "first" ? first : second),
      initialSession: source,
    });

    const firstSwitch = controller.switch("first");
    const secondSwitch = controller.switch("second");
    await vi.waitFor(() => expect(order).toContain("first:ready"));
    expect(order).not.toContain("first:list");

    releaseFirst?.();
    await Promise.all([firstSwitch, secondSwitch]);

    expect(order).toEqual([
      "source:list",
      "first:ready",
      "source:close",
      "first:list",
      "second:ready",
      "first:close",
    ]);
  });

  it("queues prompts submitted while a Session switch is in progress", async () => {
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const sourceSubmit = vi.fn(async () => "source");
    const targetSubmit = vi.fn(async () => "target");
    const source = sessionDouble({
      listSessions: vi.fn(async () => [sessionState("target")]),
      submit: sourceSubmit,
    });
    const target = sessionDouble({
      ready: vi.fn(async () => ready),
      submit: targetSubmit,
    });
    const controller = new CliSessionController({
      createSession: () => target,
      initialSession: source,
    });

    const switching = controller.switch("target");
    const submitted = controller.submit("after switch");
    await vi.waitFor(() => expect(target.ready).toHaveBeenCalled());
    expect(sourceSubmit).not.toHaveBeenCalled();
    expect(targetSubmit).not.toHaveBeenCalled();

    releaseReady?.();
    await expect(Promise.all([switching, submitted])).resolves.toEqual([undefined, "target"]);
    expect(targetSubmit).toHaveBeenCalledWith("after switch", undefined);
  });

  it("closes a failed target and keeps forwarding to the old Session", async () => {
    const sourceSubmit = vi.fn(async () => "source output");
    const sourceClose = vi.fn(async () => undefined);
    const targetClose = vi.fn(async () => undefined);
    const source = sessionDouble({
      close: sourceClose,
      listSessions: vi.fn(async () => [sessionState("target")]),
      submit: sourceSubmit,
    });
    const target = sessionDouble({
      close: targetClose,
      ready: vi.fn(async () => {
        throw new Error("target initialization failed");
      }),
    });
    const onInputEnabled = vi.fn();
    const controller = new CliSessionController({
      createSession: () => target,
      initialSession: source,
      onInputEnabled,
    });

    await expect(controller.switch("target")).rejects.toThrow("target initialization failed");
    await expect(controller.submit("continue")).resolves.toBe("source output");

    expect(targetClose).toHaveBeenCalledWith("resume");
    expect(sourceClose).not.toHaveBeenCalled();
    expect(sourceSubmit).toHaveBeenCalledWith("continue", undefined);
    expect(onInputEnabled.mock.calls).toEqual([[false], [true]]);
  });

  it("forwards submit options to the current Session", async () => {
    const submit = vi.fn(async () => "done");
    const controller = new CliSessionController({
      createSession: () => sessionDouble(),
      initialSession: sessionDouble({ submit }),
    });
    const options: CliAgentSessionSubmitOptions = {
      commandArgs: "tests",
      commandName: "review",
    };

    await expect(controller.submit("inspect", options)).resolves.toBe("done");
    expect(submit).toHaveBeenCalledWith("inspect", options);
  });

  it("forwards Session, model, MCP, output, and export services", async () => {
    const state = sessionState("current");
    const installSkill = vi.fn(async () => ({ name: "review", source: "user" as const }));
    const current = sessionDouble({
      branch: vi.fn(async () => undefined),
      checkpoints: vi.fn(async () => []),
      currentModel: vi.fn(async () => "model"),
      exportSession: vi.fn(async () => ({ filePath: "/export.md", messageCount: 2 })),
      installSkill,
      mcpStatus: vi.fn(async () => []),
      models: vi.fn(async () => [{ key: "model", model: "gpt-test" }]),
      outputStyle: vi.fn(async () => "compact"),
      reconnectMcp: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => state),
      setOutputStyle: vi.fn(async () => ({ ...state, outputStyle: "verbose" })),
    });
    const controller = new CliSessionController({
      createSession: () => sessionDouble(),
      initialSession: current,
    });

    await expect(controller.currentModel()).resolves.toBe("model");
    await expect(controller.models()).resolves.toEqual([{ key: "model", model: "gpt-test" }]);
    await expect(controller.mcpStatus()).resolves.toEqual([]);
    await expect(controller.outputStyle()).resolves.toBe("compact");
    await expect(controller.setOutputStyle("verbose")).resolves.toMatchObject({
      outputStyle: "verbose",
    });
    await expect(controller.exportSession()).resolves.toEqual({
      filePath: "/export.md",
      messageCount: 2,
    });
    await expect(controller.reconnectMcp("server")).resolves.toBeUndefined();
    await expect(controller.renameSession("current", "Title")).resolves.toEqual(state);
    await expect(controller.installSkill("owner/repo", "review", ["skills"])).resolves.toEqual({
      name: "review",
      source: "user",
    });
    expect(installSkill).toHaveBeenCalledWith("owner/repo", "review", ["skills"]);
  });

  it("replaces the current Runtime before persisting a global model default", async () => {
    const order: string[] = [];
    const source = sessionDouble({
      close: vi.fn(async () => {
        order.push("source:close");
      }),
      setCurrentModel: vi.fn(async (modelKey) => {
        order.push(`state:model:${modelKey}`);
        return { ...sessionState("current"), modelKey };
      }),
      setGlobalModel: vi.fn(async (modelKey) => {
        order.push(`global:model:${modelKey}`);
      }),
      stateSnapshot: vi.fn(async () => sessionState("current")),
    });
    const target = sessionDouble({
      ready: vi.fn(async () => {
        order.push("target:ready");
      }),
      stateSnapshot: vi.fn(async () => {
        order.push("target:snapshot");
        return { ...sessionState("current"), modelKey: "next" };
      }),
    });
    const controller = new CliSessionController({
      createSession: () => target,
      initialSession: source,
      onInputEnabled: (enabled) => {
        order.push(`input:${enabled}`);
      },
      onTimelineReplay: () => {
        order.push("timeline:replay");
      },
    });

    await controller.setModel("next", { global: true });

    expect(order).toEqual([
      "input:false",
      "state:model:next",
      "target:ready",
      "global:model:next",
      "source:close",
      "target:snapshot",
      "timeline:replay",
      "input:true",
    ]);
  });

  it("rolls back the Session model when the replacement Runtime fails", async () => {
    const setCurrentModel = vi.fn(async (modelKey: string) => ({
      ...sessionState("current"),
      modelKey,
    }));
    const sourceSubmit = vi.fn(async () => "source");
    const source = sessionDouble({
      setCurrentModel,
      stateSnapshot: vi.fn(async () => sessionState("current")),
      submit: sourceSubmit,
    });
    const targetClose = vi.fn(async () => undefined);
    const target = sessionDouble({
      close: targetClose,
      ready: vi.fn(async () => {
        throw new Error("replacement failed");
      }),
    });
    const controller = new CliSessionController({
      createSession: () => target,
      initialSession: source,
    });

    await expect(controller.setModel("next", { global: false })).rejects.toThrow(
      "replacement failed",
    );
    expect(setCurrentModel.mock.calls).toEqual([["next"], ["model"]]);
    expect(targetClose).toHaveBeenCalledWith("resume");
    await expect(controller.submit("continue")).resolves.toBe("source");
  });

  it("handles same-model defaults, missing state, missing Sessions, and branching", async () => {
    const setGlobalModel = vi.fn(async () => undefined);
    const source = sessionDouble({
      cloneCurrent: vi.fn(async () => sessionState("branch")),
      listSessions: vi.fn(async () => [sessionState("branch")]),
      setGlobalModel,
      stateSnapshot: vi.fn(async () => sessionState("current")),
    });
    const controller = new CliSessionController({
      createSession: () => sessionDouble(),
      initialSession: source,
    });

    await controller.setModel("model", { global: false });
    await controller.setModel("model", { global: true });
    expect(setGlobalModel).toHaveBeenCalledOnce();
    await expect(controller.switch("missing")).rejects.toThrow("does not exist");
    await expect(controller.branch("Alternative")).resolves.toBeUndefined();

    const missingStateController = new CliSessionController({
      createSession: () => sessionDouble(),
      initialSession: sessionDouble({
        stateSnapshot: vi.fn(async () => undefined),
      }),
    });
    await expect(missingStateController.setModel("next", { global: false })).rejects.toThrow(
      "requires a durable Session",
    );
  });
});

function sessionState(sessionId: string, status: SessionState["status"] = "active"): SessionState {
  return {
    ...createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config",
      modelKey: "model",
      now: "2026-08-10T00:00:00.000Z",
      sessionId,
      workspaceDir: "/workspace",
    }),
    status,
  };
}

function sessionDouble(overrides: Partial<CliAgentSessionContract> = {}): CliAgentSession {
  const state = sessionState("current");
  const session = {
    answerUserQuestion: vi.fn(),
    cancelUserQuestion: vi.fn(),
    checkpoints: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    cloneCurrent: vi.fn(async () => sessionState("clone")),
    compact: vi.fn(async () => undefined),
    createAgent: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    createSkill: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    currentModel: vi.fn(async () => state.modelKey),
    exportSession: vi.fn(async () => ({ filePath: "/export.md", messageCount: 0 })),
    hooks: vi.fn(async () => undefined),
    installSkill: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listAgents: vi.fn(async () => []),
    listSessions: vi.fn(async () => [state]),
    memories: vi.fn(async () => undefined),
    mcpStatus: vi.fn(async () => []),
    models: vi.fn(async () => []),
    outputStyle: vi.fn(async () => "default"),
    pendingUserQuestions: vi.fn(() => []),
    ready: vi.fn(async () => undefined),
    removeAgent: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => undefined),
    reconnectMcp: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => state),
    renameCurrent: vi.fn(async () => state),
    rewind: vi.fn(async () => undefined),
    runAgent: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    setup: vi.fn(async () => undefined),
    showAgent: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    skills: vi.fn(async () => []),
    setCurrentModel: vi.fn(async () => state),
    setGlobalModel: vi.fn(async () => undefined),
    setOutputStyle: vi.fn(async () => state),
    startSessionEpoch: vi.fn(async () => state),
    stateSnapshot: vi.fn(async () => state),
    submit: vi.fn(async () => "done"),
    ...overrides,
  } satisfies CliAgentSessionContract;

  return session as unknown as CliAgentSession;
}
