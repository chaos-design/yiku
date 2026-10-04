import { PassThrough } from "node:stream";
import {
  AgentStageStopError,
  EvaluationGateError,
  type EvaluationOutcome,
  SessionPausedError,
} from "@yiku/agent-orchestrator";
import { describe, expect, it, vi } from "vitest";
import type { CliAgentSessionContract } from "../src/agent-session.js";
import { AutomationAnswers, NonInteractiveAutomation } from "../src/automation/index.js";
import { runNonInteractivePrompt } from "../src/non-interactive.js";

describe("runNonInteractivePrompt", () => {
  it("requires a prompt when no setup or resume action is requested", async () => {
    const stderr = output();

    await expect(
      runNonInteractivePrompt({
        prompt: "",
        stderr: stderr.stream,
      }),
    ).resolves.toBe(2);
    expect(stderr.read()).toContain("Provide a prompt argument");
  });

  it("closes the shared Session Runtime after submit failure", async () => {
    const stderr = output();
    const close = vi.fn(async () => undefined);
    const session: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close,
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit: vi.fn(async () => {
        throw new Error("submit failed");
      }),
    };

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        prompt: "fail",
        stderr: stderr.stream,
      }),
    ).resolves.toBe(1);
    expect(close).toHaveBeenCalledWith("prompt_input_exit");
    expect(stderr.read()).toBe("Error: submit failed\n");
  });

  it("runs init-only without requiring a prompt or invoking the Agent", async () => {
    const stdout = output();
    const setup = vi.fn(async () => undefined);
    const submit = vi.fn(async () => "unused");
    const session: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup,
      submit,
    };

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        initOnly: true,
        prompt: "",
        setupMode: "init",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(setup).toHaveBeenCalledWith("init");
    expect(submit).not.toHaveBeenCalled();
    expect(stdout.read()).toBe("Setup completed.\n");
  });

  it("continues a durable Session without an explicit prompt", async () => {
    const stdout = output();
    const submit = vi.fn(async () => "resumed");
    const session: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit,
    };

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        continueSession: true,
        prompt: "",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(submit).toHaveBeenCalledWith(
      "Continue working from the saved Session.",
      expect.objectContaining({
        userQuestionHandler: expect.any(Function),
      }),
    );
    expect(stdout.read()).toBe("resumed\n");
  });

  it("constructs an injected Session for continue and resume requests", async () => {
    const runPrompt = vi.fn(async (prompt: string) => `ran:${prompt}`);
    const continuedOutput = output();

    await expect(
      runNonInteractivePrompt({
        agentKey: "code",
        continueSession: true,
        prompt: "",
        runPromptImpl: runPrompt,
        stdout: continuedOutput.stream,
      }),
    ).resolves.toBe(0);
    expect(runPrompt).toHaveBeenNthCalledWith(
      1,
      "Continue working from the saved Session.",
      expect.objectContaining({ agentKey: "code" }),
    );
    expect(continuedOutput.read()).toBe("ran:Continue working from the saved Session.\n");

    const resumedOutput = output();
    await expect(
      runNonInteractivePrompt({
        prompt: "resume work",
        resumeSessionId: "session-1",
        runPromptImpl: runPrompt,
        stdout: resumedOutput.stream,
      }),
    ).resolves.toBe(0);
    expect(runPrompt).toHaveBeenNthCalledWith(
      2,
      "resume work",
      expect.not.objectContaining({ agentKey: expect.anything() }),
    );
    expect(resumedOutput.read()).toBe("ran:resume work\n");
  });

  it("fails closed when a question has no stable automation metadata", async () => {
    const stdout = output();
    const session = stubSession(async (_prompt, options) => {
      try {
        await options?.userQuestionHandler?.({
          options: ["PostgreSQL", "SQLite"],
          question: "Which database?",
        });
      } catch {
        return "tool error was converted to output";
      }
      return "unreachable";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        outputFormat: "json",
        prompt: "run",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(5);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_NEEDS_INPUT" },
      status: "needs-input",
    });
  });

  it("uses stable answers and explicit low-risk recommendations", async () => {
    const stdout = output();
    const audit = { append: vi.fn(async () => undefined) };
    const automation = new NonInteractiveAutomation({
      answers: new AutomationAnswers(
        "/answers.json",
        new Map([["code.storage.database@1", { optionId: "postgresql" }]]),
      ),
      audit,
      questionManifests: [
        {
          allowAutoRecommended: false,
          multiSelect: false,
          optionIds: ["sqlite", "postgresql"],
          preconfiguredAnswer: false,
          questionKey: "code.storage.database@1",
          risk: "preference",
        },
        {
          allowAutoRecommended: true,
          multiSelect: false,
          optionIds: ["json", "text"],
          preconfiguredAnswer: false,
          questionKey: "cli.output.format@1",
          recommendedOptionId: "json",
          risk: "preference",
        },
      ],
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    const session = stubSession(async (_prompt, options) => {
      const response = await options?.userQuestionHandler?.({
        questions: [
          {
            allowAutoRecommended: false,
            header: "Database",
            multiSelect: false,
            options: [
              { description: "Local", label: "SQLite", optionId: "sqlite" },
              { description: "Remote", label: "PostgreSQL", optionId: "postgresql" },
            ],
            question: "Choose a database.",
            questionKey: "code.storage.database@1",
            risk: "preference",
          },
          {
            allowAutoRecommended: true,
            header: "Format",
            multiSelect: false,
            options: [
              {
                description: "Machine readable",
                label: "JSON",
                optionId: "json",
                recommended: true,
              },
              { description: "Human readable", label: "Text", optionId: "text" },
            ],
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
      });
      expect(response).toEqual({
        answers: [
          { answers: ["PostgreSQL"], questionIndex: 0, selectedIndexes: [1] },
          { answers: ["JSON"], questionIndex: 1, selectedIndexes: [0] },
        ],
      });
      return "handled";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        automation,
        prompt: "run",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(stdout.read()).toBe("handled\n");
    expect(audit.append).toHaveBeenCalledTimes(2);
  });

  it("reports low-risk audit degradation to stderr and machine output", async () => {
    const stderr = output();
    const stdout = output();
    const automation = new NonInteractiveAutomation({
      audit: {
        append: vi.fn(async () => {
          throw new Error("audit unavailable");
        }),
      },
      questionManifests: [
        {
          allowAutoRecommended: true,
          multiSelect: false,
          optionIds: ["json", "text"],
          preconfiguredAnswer: false,
          questionKey: "cli.output.format@1",
          recommendedOptionId: "json",
          risk: "preference",
        },
      ],
      sessionId: "session-1",
      workspaceId: "/workspace",
    });
    const session = stubSession(async (_prompt, options) => {
      await options?.userQuestionHandler?.({
        questions: [
          {
            allowAutoRecommended: true,
            header: "Format",
            multiSelect: false,
            options: [
              {
                description: "Machine readable",
                label: "JSON",
                optionId: "json",
                recommended: true,
              },
              { description: "Human readable", label: "Text", optionId: "text" },
            ],
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
      });
      return "handled";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        automation,
        outputFormat: "json",
        prompt: "run",
        stderr: stderr.stream,
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(stderr.read()).toContain("Unable to persist low-risk automation audit record");
    expect(JSON.parse(stdout.read())).toMatchObject({
      diagnostics: [{ code: "CLI_AUDIT_DEGRADED" }],
      output: "handled",
      status: "completed",
    });
  });

  it("returns approval-required before an unconfigured side effect", async () => {
    const stdout = output();
    const runPromptImpl = vi.fn(async (_prompt, options) => {
      try {
        await options?.permissionApprovalHandler?.({
          action: "execute",
          capabilities: ["process.execute"],
          normalizedAction: "pnpm test",
          policyId: "test-command",
          reason: "Command requires approval.",
          risk: "medium",
          subject: "pnpm test",
          toolName: "bashTool",
          workspaceId: "workspace-1",
        });
      } catch {
        return "tool error was converted to output";
      }
      return "unreachable";
    });

    await expect(
      runNonInteractivePrompt({
        outputFormat: "json",
        prompt: "run",
        runPromptImpl,
        stdout: stdout.stream,
      }),
    ).resolves.toBe(5);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: {
        capability: "process.execute",
        code: "CLI_APPROVAL_REQUIRED",
      },
      status: "needs-input",
    });
  });

  it("fails closed when a Tool converts a runtime permission denial to output", async () => {
    const stdout = output();
    const session = stubSession(async (_prompt, options) => {
      try {
        await options?.permissionAssessmentHandler?.(
          {
            action: "execute",
            capabilities: ["process.execute"],
            normalizedAction: "git reset --hard",
            policyId: "git-reset-hard",
            reason: "Command is denied by the runtime policy.",
            risk: "high",
            subject: "git reset --hard",
            toolName: "bashTool",
            workspaceId: "workspace-1",
          },
          "deny",
        );
      } catch {
        return "tool error was converted to output";
      }
      return "unreachable";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        outputFormat: "json",
        prompt: "run",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(4);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: {
        capability: "process.execute",
        code: "CLI_POLICY_DENIED",
      },
      status: "failed",
    });
  });

  it("fails closed when a Tool converts a Workspace approval error to output", async () => {
    const stdout = output();
    const session = stubSession(async (_prompt, options) => {
      try {
        await options?.workspaceAccessApprovalHandler?.({
          action: "edit",
          subject: "src/index.ts",
          workspaceId: "workspace-1",
        });
      } catch {
        return "tool error was converted to output";
      }
      return "unreachable";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        outputFormat: "json",
        prompt: "run",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(5);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: {
        capability: "workspace.write",
        code: "CLI_APPROVAL_REQUIRED",
      },
      status: "needs-input",
    });
  });

  it("runs an injected prompt function with optional Agent identity and empty output", async () => {
    const firstOutput = output();
    const runPrompt = vi.fn(async () => "");

    await expect(
      runNonInteractivePrompt({
        prompt: "first",
        runPromptImpl: runPrompt,
        stdout: firstOutput.stream,
      }),
    ).resolves.toBe(0);
    expect(runPrompt).toHaveBeenNthCalledWith(
      1,
      "first",
      expect.objectContaining({
        accessMode: "read-only",
        permissionApprovalHandler: expect.any(Function),
        userQuestionHandler: expect.any(Function),
      }),
    );
    expect(firstOutput.read()).toBe("(empty output)\n");

    const secondOutput = output();
    await expect(
      runNonInteractivePrompt({
        agentKey: "research",
        prompt: "second",
        runPromptImpl: runPrompt,
        stdout: secondOutput.stream,
      }),
    ).resolves.toBe(0);
    expect(runPrompt).toHaveBeenNthCalledWith(
      2,
      "second",
      expect.objectContaining({
        agentKey: "research",
        permissionApprovalHandler: expect.any(Function),
      }),
    );
  });

  it("formats non-Error prompt failures", async () => {
    const stderr = output();

    await expect(
      runNonInteractivePrompt({
        prompt: "fail",
        runPromptImpl: async () => {
          throw "string failure";
        },
        stderr: stderr.stream,
      }),
    ).resolves.toBe(1);
    expect(stderr.read()).toBe("Error: string failure\n");
  });

  it("writes JSON and NDJSON evaluation protocols without diagnostics on stdout", async () => {
    const evaluation = {
      attempts: [],
      decision: {
        action: "accepted",
      },
      finalOutput: "done",
      scorecard: {
        grade: "A",
        overallScore: 0.9,
      },
    } as unknown as EvaluationOutcome;
    const session = (format: "json" | "ndjson"): CliAgentSessionContract => ({
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      evaluationOutcome: () => evaluation,
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit: vi.fn(async (_prompt, options) => {
        options?.onEvent?.({
          attempts: 1,
          counts: { error: 0, failed: 0, "not-run": 0, passed: 7 },
          decision: "accepted",
          failedChecks: [],
          grade: "A",
          overallScore: 0.9,
          type: "evaluation_finished",
        });
        return format === "json" ? "json result" : "ndjson result";
      }),
    });

    const json = output();
    await expect(
      runNonInteractivePrompt({
        agentSession: session("json"),
        outputFormat: "json",
        prompt: "run",
        stdout: json.stream,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(json.read())).toMatchObject({
      evaluation: {
        decision: { action: "accepted" },
      },
      output: "json result",
      status: "completed",
      verification: {
        decision: "accepted",
      },
    });

    const ndjson = output();
    await expect(
      runNonInteractivePrompt({
        agentSession: session("ndjson"),
        outputFormat: "ndjson",
        prompt: "run",
        stdout: ndjson.stream,
      }),
    ).resolves.toBe(0);
    const lines = ndjson
      .read()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly type: string });
    expect(lines.map((line) => line.type)).toEqual(["verification.completed", "session.completed"]);
  });

  it("writes text evaluation summaries and ignores unrelated progress events", async () => {
    const stdout = output();
    const session = stubSession(async (_prompt, options) => {
      options?.onEvent?.({ type: "agent_started" } as Parameters<
        NonNullable<NonNullable<Parameters<CliAgentSessionContract["submit"]>[1]>["onEvent"]>
      >[0]);
      options?.onEvent?.({
        attempts: 1,
        counts: { error: 1, failed: 2, "not-run": 3, passed: 4 },
        decision: "degraded",
        failedChecks: ["check"],
        grade: "B",
        overallScore: 0.812,
        type: "evaluation_finished",
      });
      return "done";
    });

    await expect(
      runNonInteractivePrompt({
        agentSession: session,
        prompt: "run",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(stdout.read()).toContain(
      "Evaluation: degraded · B · 81.2 · 4 passed, 2 failed, 1 error, 3 not-run",
    );
  });

  it("maps gate failures to stable JSON and NDJSON protocols and exit codes", async () => {
    for (const [action, format, expectedExit] of [
      ["needs-review", "json", 6],
      ["rejected", "ndjson", 8],
      ["retry", "json", 6],
    ] as const) {
      const stdout = output();
      const outcome = {
        decision: {
          action,
          reasons: ["Gate failed."],
        },
      } as unknown as EvaluationOutcome;
      await expect(
        runNonInteractivePrompt({
          outputFormat: format,
          prompt: "run",
          runPromptImpl: async () => {
            throw new EvaluationGateError(outcome);
          },
          stdout: stdout.stream,
        }),
      ).resolves.toBe(expectedExit);
      const payload = JSON.parse(stdout.read()) as {
        readonly error: { readonly code: string };
        readonly evaluation: EvaluationOutcome;
        readonly status: string;
        readonly type?: string;
      };
      expect(payload).toMatchObject({
        error: {
          code: `EVAL_${action.toUpperCase().replaceAll("-", "_")}`,
        },
        evaluation: outcome,
        status: action === "rejected" ? "failed" : action === "retry" ? "needs-review" : action,
        ...(format === "ndjson" ? { type: "session.failed" } : {}),
      });
    }
  });

  it("returns the stable paused status and budget exit code", async () => {
    const stdout = output();

    await expect(
      runNonInteractivePrompt({
        outputFormat: "json",
        prompt: "run",
        runPromptImpl: async () => {
          throw new AgentStageStopError({ stopReason: "max_turns" });
        },
        stdout: stdout.stream,
      }),
    ).resolves.toBe(7);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_EXECUTION_FAILED" },
      status: "paused",
    });
  });

  it("maps uncertain resumed side effects to the review-required contract", async () => {
    const stdout = output();

    await expect(
      runNonInteractivePrompt({
        outputFormat: "json",
        prompt: "resume",
        runPromptImpl: async () => {
          throw new SessionPausedError("needs-review", {} as never);
        },
        stdout: stdout.stream,
      }),
    ).resolves.toBe(6);
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_REVIEW_REQUIRED" },
      status: "needs-review",
    });
  });

  it("preserves coded failures and completed machine-readable output without evaluations", async () => {
    const json = output();
    await expect(
      runNonInteractivePrompt({
        outputFormat: "json",
        prompt: "run",
        runPromptImpl: async () => "plain",
        stdout: json.stream,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(json.read())).toEqual({
      output: "plain",
      status: "completed",
    });

    const ndjsonSuccess = output();
    await expect(
      runNonInteractivePrompt({
        outputFormat: "ndjson",
        prompt: "run",
        runPromptImpl: async () => "plain",
        stdout: ndjsonSuccess.stream,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(ndjsonSuccess.read())).toEqual({
      output: "plain",
      status: "completed",
      type: "session.completed",
    });

    const ndjsonFailure = output();
    const coded = Object.assign(new Error("Provider unavailable"), {
      code: "EVAL_PROVIDER_UNAVAILABLE",
    });
    await expect(
      runNonInteractivePrompt({
        outputFormat: "ndjson",
        prompt: "run",
        runPromptImpl: async () => {
          throw coded;
        },
        stdout: ndjsonFailure.stream,
      }),
    ).resolves.toBe(9);
    expect(JSON.parse(ndjsonFailure.read())).toEqual({
      error: {
        code: "EVAL_PROVIDER_UNAVAILABLE",
        message: "Provider unavailable",
      },
      status: "failed",
      type: "session.failed",
    });

    const jsonFailure = output();
    await expect(
      runNonInteractivePrompt({
        outputFormat: "json",
        prompt: "run",
        runPromptImpl: async () => {
          throw Object.assign(new Error("Invalid code"), { code: 500 });
        },
        stdout: jsonFailure.stream,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(jsonFailure.read())).toEqual({
      error: {
        code: "CLI_EXECUTION_FAILED",
        message: "Invalid code",
      },
      status: "failed",
    });
  });
});

function stubSession(submit: CliAgentSessionContract["submit"]): CliAgentSessionContract {
  return {
    answerUserQuestion: vi.fn(),
    cancelUserQuestion: vi.fn(),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    hooks: vi.fn(async () => undefined),
    pendingUserQuestions: () => [],
    setup: vi.fn(async () => undefined),
    submit,
  };
}

function output(): {
  readonly read: () => string;
  readonly stream: NodeJS.WriteStream;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as NodeJS.WriteStream;
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  return {
    read: () => chunks.join(""),
    stream,
  };
}
