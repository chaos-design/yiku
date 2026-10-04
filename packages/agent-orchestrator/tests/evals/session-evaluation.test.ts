import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeEvalProfile } from "@yiku/agent-code";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { createDefaultEvalProfile, FileEvalResultStore } from "@yiku/evals";
import type { MemoryContext, MemoryManager } from "@yiku/memories";
import type {
  ShellProcessSandbox,
  ShellSandboxLaunchInput,
  ShellSandboxLaunchSpec,
} from "@yiku/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvaluationGateError,
  type EvaluationOutcome,
  latestUserPrompt,
  type RunInput,
  runAgentSession,
  runAgentSessionTurn,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("industrial Session evaluation", () => {
  it("enforces accepted evaluations and persists their outcome", async () => {
    const cwd = temporaryDirectory();
    const homeDir = temporaryDirectory();
    const outcomes: EvaluationOutcome[] = [];
    const atomicFlow = new AtomicFlowRun({ runId: "industrial-run" });
    const store = new FileEvalResultStore({
      rootDir: join(homeDir, "evals"),
    });

    await expect(
      runAgentSession("evaluate", {
        atomicFlow,
        cwd,
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        evals: {
          onOutcome: (outcome) => outcomes.push(outcome),
          profile: createDefaultEvalProfile({
            maxRepairAttempts: 0,
            mode: "enforce",
            timeoutMs: 1_000,
          }),
          store,
        },
        modelsConfig: {},
        runImpl: vi.fn(async () => ({ finalOutput: "done" })),
        sessionId: "industrial-session",
        sessionsDir: temporaryDirectory(),
      }),
    ).resolves.toBe("done");

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.decision.action).toBe("accepted");
    await expect(
      store.readAttempt("industrial-run", outcomes[0]?.scorecard.attemptId ?? ""),
    ).resolves.toMatchObject({
      decision: {
        action: "accepted",
      },
    });
    await atomicFlow.close();
  });

  it("uses distinct Eval Run IDs when one Atomic Flow contains multiple turns", async () => {
    const atomicFlow = new AtomicFlowRun({ runId: "multi-turn-run" });
    const outcomes: EvaluationOutcome[] = [];
    const store = new FileEvalResultStore({
      rootDir: join(temporaryDirectory(), "evals"),
    });
    const options = {
      atomicFlow,
      cwd: temporaryDirectory(),
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
      },
      evals: {
        onOutcome: (outcome: EvaluationOutcome) => outcomes.push(outcome),
        profile: createDefaultEvalProfile({
          maxRepairAttempts: 0,
          mode: "enforce" as const,
          timeoutMs: 1_000,
        }),
        store,
      },
      modelsConfig: {},
      runImpl: vi.fn(async () => ({ finalOutput: "done" })),
      sessionId: "multi-turn-session",
      sessionsDir: temporaryDirectory(),
    };

    await expect(runAgentSessionTurn("first", options)).resolves.toBe("done");
    await expect(runAgentSessionTurn("second", options)).resolves.toBe("done");

    expect(outcomes.map((outcome) => outcome.plan.runId)).toEqual([
      "multi-turn-run",
      "multi-turn-run.eval-2",
    ]);
    await expect(
      store.readAttempt("multi-turn-run", outcomes[0]?.attempts[0]?.attemptId ?? ""),
    ).resolves.toBeDefined();
    await expect(
      store.readAttempt("multi-turn-run.eval-2", outcomes[1]?.attempts[0]?.attemptId ?? ""),
    ).resolves.toBeDefined();
    await atomicFlow.close();
  });

  it("blocks rejected Enforce results", async () => {
    const atomicFlow = new AtomicFlowRun({ runId: "rejected-run" });
    const running = runAgentSession("evaluate", {
      atomicFlow,
      cwd: temporaryDirectory(),
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
      },
      homeDir: temporaryDirectory(),
      evals: {
        profile: createDefaultEvalProfile({
          maxRepairAttempts: 0,
          mode: "enforce",
          timeoutMs: 1_000,
        }),
        repair: false,
        store: new FileEvalResultStore({
          rootDir: join(temporaryDirectory(), "evals"),
        }),
      },
      modelsConfig: {},
      runImpl: vi.fn(async () => ({ finalOutput: " " })),
      sessionsDir: temporaryDirectory(),
    });

    await expect(running).rejects.toBeInstanceOf(EvaluationGateError);
    expect(
      atomicFlow
        .snapshot()
        .events.some(
          (event) =>
            event.atom.key === "eval.gate" &&
            event.phase === "end" &&
            event.payload?.summary === "rejected",
        ),
    ).toBe(true);
    await atomicFlow.close();
  });

  it("repairs once and returns the repaired output", async () => {
    const outcomes: EvaluationOutcome[] = [];
    const runImpl = vi.fn(async (_agent, prompt: RunInput) => ({
      finalOutput: latestUserPrompt(prompt).startsWith("Repair the previous") ? "fixed" : " ",
    }));

    await expect(
      runAgentSession("evaluate", {
        cwd: temporaryDirectory(),
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        homeDir: temporaryDirectory(),
        evals: {
          onOutcome: (outcome) => outcomes.push(outcome),
          profile: createDefaultEvalProfile({
            maxRepairAttempts: 1,
            mode: "enforce",
            timeoutMs: 1_000,
          }),
          store: new FileEvalResultStore({
            rootDir: join(temporaryDirectory(), "evals"),
          }),
        },
        modelsConfig: {},
        runImpl,
        sessionsDir: temporaryDirectory(),
      }),
    ).resolves.toBe("fixed");

    expect(runImpl).toHaveBeenCalledTimes(2);
    expect(outcomes[0]?.attempts.map((attempt) => attempt.decision.action)).toEqual([
      "retry",
      "accepted",
    ]);
  });

  it("keeps Observe failures non-blocking without automatic repair", async () => {
    const outcomes: EvaluationOutcome[] = [];
    const runImpl = vi.fn(async () => ({ finalOutput: " " }));

    await expect(
      runAgentSession("evaluate", {
        cwd: temporaryDirectory(),
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        homeDir: temporaryDirectory(),
        evals: {
          onOutcome: (outcome) => outcomes.push(outcome),
          profile: createDefaultEvalProfile({
            maxRepairAttempts: 1,
            mode: "observe",
            timeoutMs: 1_000,
          }),
          store: new FileEvalResultStore({
            rootDir: join(temporaryDirectory(), "evals"),
          }),
        },
        modelsConfig: {},
        runImpl,
        sessionsDir: temporaryDirectory(),
      }),
    ).resolves.toBe(" ");

    expect(runImpl).toHaveBeenCalledOnce();
    expect(outcomes[0]?.decision.action).toBe("rejected");
  });

  it("promotes Memory only after an accepted gate", async () => {
    const order: string[] = [];
    const manager = {
      ingestSession: vi.fn(async () => {
        order.push("memory");
      }),
      recall: vi.fn(async () => []),
    } as unknown as MemoryManager;
    const memories = {
      context: { scope: {} } as MemoryContext,
      extraction: { enabled: true },
      manager,
    };
    const acceptedOptions = {
      cwd: temporaryDirectory(),
      env: {
        AI_MODEL: "gpt-test",
        OPENAI_API_KEY: "test-key",
      },
      evals: {
        onOutcome: () => order.push("outcome"),
        profile: createDefaultEvalProfile({
          maxRepairAttempts: 0,
          mode: "enforce" as const,
          timeoutMs: 1_000,
        }),
        store: new FileEvalResultStore({
          rootDir: join(temporaryDirectory(), "evals"),
        }),
      },
      homeDir: temporaryDirectory(),
      memories,
      modelsConfig: {},
      sessionsDir: temporaryDirectory(),
    };
    await runAgentSession("accepted", {
      ...acceptedOptions,
      runImpl: vi.fn(async () => ({ finalOutput: "done" })),
    });
    expect(order).toEqual(["outcome", "memory"]);

    order.length = 0;
    await expect(
      runAgentSession("rejected", {
        ...acceptedOptions,
        evals: {
          ...acceptedOptions.evals,
          onOutcome: () => order.push("outcome"),
          repair: false,
          store: new FileEvalResultStore({
            rootDir: join(temporaryDirectory(), "evals"),
          }),
        },
        runImpl: vi.fn(async () => ({ finalOutput: " " })),
      }),
    ).rejects.toBeInstanceOf(EvaluationGateError);
    expect(order).toEqual(["outcome"]);
  });

  it("runs write-producing verification commands in a disposable workspace", async () => {
    const cwd = temporaryDirectory();
    const marker = join(cwd, "verification-marker");
    const profile = createCodeEvalProfile({
      commands: [
        {
          args: ["-e", "require('node:fs').writeFileSync('verification-marker', 'isolated')"],
          command: process.execPath,
          cwd: ".",
          envAllowlist: [],
          id: "isolated-write",
          network: "deny",
          timeoutMs: 1_000,
          writePolicy: "isolated",
        },
      ],
      maxRepairAttempts: 0,
      requireChanges: false,
      timeoutMs: 2_000,
    });

    await expect(
      runAgentSession("evaluate", {
        cwd,
        env: {
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        evals: {
          profile,
          store: new FileEvalResultStore({
            rootDir: join(temporaryDirectory(), "evals"),
          }),
        },
        homeDir: temporaryDirectory(),
        modelsConfig: {},
        runImpl: vi.fn(async () => ({ finalOutput: "done" })),
        sessionsDir: temporaryDirectory(),
        shellSandbox: new DirectSandbox(),
      }),
    ).resolves.toBe("done");

    expect(existsSync(marker)).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = join(
    tmpdir(),
    `yiku-session-eval-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  mkdirSync(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}

class DirectSandbox implements ShellProcessSandbox {
  public readonly isolation = "sandbox" as const;
  public readonly network = "deny" as const;

  public close(): void {}

  public createLaunchSpec(input: ShellSandboxLaunchInput): ShellSandboxLaunchSpec {
    return {
      args: [],
      command: input.shellPath,
      cwd: input.cwd ?? input.workspace.rootDir,
      environment: input.environment,
    };
  }
}
