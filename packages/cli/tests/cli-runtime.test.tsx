import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliAgentSessionContract } from "../src/agent-session.js";
import { type RunCliRuntimeOptions, runCliRuntime, supportsRawMode } from "../src/cli-runtime.js";
import { runNonInteractivePrompt } from "../src/non-interactive.js";
import type { RunWebCommandOptions } from "../src/web/web-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function createInput(isTTY: boolean): NodeJS.ReadStream {
  const input = new PassThrough() as NodeJS.ReadStream;

  Object.defineProperty(input, "isTTY", {
    configurable: true,
    value: isTTY,
  });

  if (isTTY) {
    input.setRawMode = vi.fn(() => input);
  }

  return input;
}

function createOutput(): {
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

describe("supportsRawMode", () => {
  it("requires a TTY with setRawMode", () => {
    const ttyWithoutRawMode = createInput(false);
    Object.defineProperty(ttyWithoutRawMode, "isTTY", {
      configurable: true,
      value: true,
    });

    expect(supportsRawMode(createInput(true))).toBe(true);
    expect(supportsRawMode(createInput(false))).toBe(false);
    expect(supportsRawMode(ttyWithoutRawMode)).toBe(false);
  });
});

describe("runCliRuntime", () => {
  it("prints help without rendering or calling the model", async () => {
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "not called");

    await expect(
      runCliRuntime({
        argv: ["--help"],
        runPromptImpl,
        stdin: createInput(false),
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(stdout.read()).toContain("Usage:");
    expect(runPromptImpl).not.toHaveBeenCalled();
  });

  it("keeps argument failures machine-readable when output format is valid", async () => {
    const stderr = createOutput();
    const stdout = createOutput();

    await expect(
      runCliRuntime({
        argv: ["--output-format", "json", "--policy"],
        stderr: stderr.stream,
        stdin: createInput(false),
        stdout: stdout.stream,
      }),
    ).resolves.toBe(2);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_INVALID_ARGUMENT" },
      status: "failed",
    });
  });

  it("fails closed before model execution when a Non-TTY workspace is unauthorized", async () => {
    const stderr = createOutput();
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "model result");

    await expect(
      runCliRuntime({
        argv: ["review", "this"],
        runPromptImpl,
        stderr: stderr.stream,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore: {
          get: vi.fn(async () => undefined),
          trust: vi.fn(),
        },
      }),
    ).resolves.toBe(3);
    expect(runPromptImpl).not.toHaveBeenCalled();
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Workspace is not authorized");
  });

  it("runs Non-TTY text output by default for an authorized workspace", async () => {
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "model result");
    const workspaceTrustStore = {
      get: vi.fn(async () => ({
        accessMode: "read-only" as const,
        expiresAt: "2026-08-20T00:00:00.000Z",
        trustedAt: "2026-08-13T00:00:00.000Z",
        workspaceDir: process.cwd(),
      })),
      trust: vi.fn(),
    };

    await expect(
      runCliRuntime({
        argv: ["review"],
        runPromptImpl,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore,
      }),
    ).resolves.toBe(0);
    expect(stdout.read()).toBe("model result\n");
  });

  it("runs structured non-interactive output only for an authorized workspace", async () => {
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "model result");
    const workspaceTrustStore = {
      get: vi.fn(async () => ({
        accessMode: "read-only" as const,
        expiresAt: "2026-08-20T00:00:00.000Z",
        trustedAt: "2026-08-13T00:00:00.000Z",
        workspaceDir: process.cwd(),
      })),
      trust: vi.fn(),
    };

    await expect(
      runCliRuntime({
        argv: ["--output", "json", "review"],
        runPromptImpl,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore,
      }),
    ).resolves.toBe(0);
    expect(runPromptImpl).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({
        accessMode: "read-only",
      }),
    );
    expect(JSON.parse(stdout.read())).toMatchObject({
      output: "model result",
      status: "completed",
    });
  });

  it("rejects an empty Non-TTY invocation before checking workspace trust", async () => {
    const stderr = createOutput();
    const workspaceTrustStore = {
      get: vi.fn(async () => undefined),
      trust: vi.fn(),
    };

    await expect(
      runCliRuntime({
        argv: [],
        stderr: stderr.stream,
        stdin: createInput(false),
        workspaceTrustStore,
      }),
    ).resolves.toBe(2);
    await expect(
      runCliRuntime({
        argv: ["--maintenance"],
        stderr: stderr.stream,
        stdin: createInput(false),
        workspaceTrustStore,
      }),
    ).resolves.toBe(2);
    expect(workspaceTrustStore.get).not.toHaveBeenCalled();
    expect(stderr.read()).toContain("Provide a prompt argument");
  });

  it("loads explicit answers after trust and resolves stable questions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-automation-"));
    temporaryDirectories.push(directory);
    const answersFilePath = join(directory, "answers.json");
    await writeFile(
      answersFilePath,
      JSON.stringify({
        answers: {
          "cli.output.format@1": { optionId: "json" },
        },
        manifests: [
          {
            allowAutoRecommended: false,
            multiSelect: false,
            optionIds: ["json", "text"],
            preconfiguredAnswer: false,
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
        schemaVersion: 1,
      }),
      { mode: 0o600 },
    );
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async (_prompt, options) => {
      const response = await options?.userQuestionHandler?.({
        questions: [
          {
            header: "Format",
            multiSelect: false,
            options: [
              { description: "Machine", label: "JSON", optionId: "json" },
              { description: "Human", label: "Text", optionId: "text" },
            ],
            question: "Choose output.",
            questionKey: "cli.output.format@1",
            risk: "preference",
          },
        ],
      });
      expect(response).toMatchObject({
        answers: [{ answers: ["JSON"], selectedIndexes: [0] }],
      });
      return "answered";
    });

    await expect(
      runCliRuntime({
        argv: ["--output-format", "json", "--answers", answersFilePath, "review"],
        automationAuditFilePath: join(directory, "audit", "cli-policy.ndjson"),
        runPromptImpl,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore: {
          get: vi.fn(async () => ({
            accessMode: "read-only" as const,
            expiresAt: "2026-08-20T00:00:00.000Z",
            trustedAt: "2026-08-13T00:00:00.000Z",
            workspaceDir: process.cwd(),
          })),
          trust: vi.fn(),
        },
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.read())).toMatchObject({
      output: "answered",
      status: "completed",
    });
  });

  it("rejects invalid automation input before model execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yiku-cli-invalid-automation-"));
    temporaryDirectories.push(directory);
    const answersFilePath = join(directory, "answers.json");
    await writeFile(answersFilePath, '{"schemaVersion":2,"answers":{}}', { mode: 0o600 });
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "unreachable");

    await expect(
      runCliRuntime({
        argv: ["--output-format", "json", "--answers", answersFilePath, "review"],
        runPromptImpl,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore: {
          get: vi.fn(async () => ({
            accessMode: "read-only" as const,
            expiresAt: "2026-08-20T00:00:00.000Z",
            trustedAt: "2026-08-13T00:00:00.000Z",
            workspaceDir: process.cwd(),
          })),
          trust: vi.fn(),
        },
      }),
    ).resolves.toBe(2);
    expect(runPromptImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_INVALID_AUTOMATION_INPUT" },
      status: "failed",
    });
  });

  it("returns authorization exit code before structured non-interactive execution", async () => {
    const stderr = createOutput();
    const stdout = createOutput();
    const runPromptImpl = vi.fn(async () => "model result");

    await expect(
      runCliRuntime({
        argv: ["--output-format=json", "review"],
        runPromptImpl,
        stderr: stderr.stream,
        stdin: createInput(false),
        stdout: stdout.stream,
        workspaceTrustStore: {
          get: vi.fn(async () => undefined),
          trust: vi.fn(),
        },
      }),
    ).resolves.toBe(3);
    expect(runPromptImpl).not.toHaveBeenCalled();
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toMatchObject({
      error: { code: "CLI_WORKSPACE_UNAUTHORIZED" },
      status: "failed",
    });
  });

  it("rejects Web conversation mode before starting a server without an interactive TTY", async () => {
    const runWebImpl = vi.fn(async () => 0);
    const stderr = createOutput();

    await expect(
      runCliRuntime({
        argv: ["web", "--port", "3333"],
        runWebImpl,
        stderr: stderr.stream,
        stdin: createInput(false),
      }),
    ).resolves.toBe(1);
    expect(runWebImpl).not.toHaveBeenCalled();
    expect(stderr.read()).toBe("Error: Yiku Web conversation requires an interactive TTY.\n");
  });

  it("starts Web conversation mode and injects its endpoint into the Ink session", async () => {
    const environment = {
      TEST_VALUE: "preserved",
      YIKU_ATOMIC_STUDIO_URL: "http://127.0.0.1:1111",
    };
    const renderMock = vi.fn(
      (
        node: ReactElement<{
          agentEnvironment: NodeJS.ProcessEnv;
          onExitCode: (code: number) => void;
        }>,
      ) => {
        expect(node.props.agentEnvironment).toEqual({
          TEST_VALUE: "preserved",
          YIKU_ATOMIC_STUDIO_URL: "http://127.0.0.1:3333",
        });
        node.props.onExitCode(4);
        return {
          waitUntilExit: async () => undefined,
        };
      },
    );
    const runWebImpl = vi.fn(async (webOptions: RunWebCommandOptions) => {
      expect(webOptions.runConversation).toEqual(expect.any(Function));
      return webOptions.runConversation?.("http://127.0.0.1:3333") ?? 1;
    });

    await expect(
      runCliRuntime({
        argv: ["web", "--port", "3333"],
        environment,
        renderImpl: renderMock as unknown as NonNullable<RunCliRuntimeOptions["renderImpl"]>,
        runWebImpl,
        stdin: createInput(true),
      }),
    ).resolves.toBe(4);

    expect(runWebImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3333,
        runConversation: expect.any(Function),
      }),
    );
    expect(environment.YIKU_ATOMIC_STUDIO_URL).toBe("http://127.0.0.1:1111");
  });

  it("stops Web observer mode without requiring an interactive TTY", async () => {
    const runWebImpl = vi.fn(async () => 0);

    await expect(
      runCliRuntime({
        argv: ["web", "--stop"],
        runWebImpl,
        stdin: createInput(false),
      }),
    ).resolves.toBe(0);
    expect(runWebImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4317,
        stop: true,
      }),
    );
  });

  it("prints Web argument errors without starting a server", async () => {
    const runWebImpl = vi.fn(async () => 0);
    const stderr = createOutput();

    await expect(
      runCliRuntime({
        argv: ["web", "--port", "invalid"],
        runWebImpl,
        stderr: stderr.stream,
        stdin: createInput(false),
      }),
    ).resolves.toBe(2);
    expect(stderr.read()).toContain("--port must be an integer");
    expect(runWebImpl).not.toHaveBeenCalled();
  });

  it("renders interactive mode with Ink ctrl+c handling disabled", async () => {
    const stderr = createOutput();
    const stdout = createOutput();
    const renderMock = vi.fn((node: ReactElement<{ onExitCode: (code: number) => void }>) => {
      node.props.onExitCode(2);

      return {
        waitUntilExit: async () => undefined,
      };
    });
    const renderImpl = renderMock as unknown as NonNullable<RunCliRuntimeOptions["renderImpl"]>;

    await expect(
      runCliRuntime({
        argv: [],
        renderImpl,
        stderr: stderr.stream,
        stdin: createInput(true),
        stdout: stdout.stream,
      }),
    ).resolves.toBe(2);
    expect(renderMock).toHaveBeenCalledOnce();
    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({
      exitOnCtrlC: false,
    });
  });

  it("rejects automation files in interactive mode", async () => {
    const stderr = createOutput();
    const renderImpl = vi.fn();

    await expect(
      runCliRuntime({
        argv: ["--answers", "/tmp/answers.json", "review"],
        renderImpl,
        stderr: stderr.stream,
        stdin: createInput(true),
      }),
    ).resolves.toBe(2);
    expect(renderImpl).not.toHaveBeenCalled();
    expect(stderr.read()).toContain("only valid in non-interactive mode");
  });
});

describe("runNonInteractivePrompt", () => {
  it("uses process output streams by default", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      await expect(
        runNonInteractivePrompt({
          prompt: "direct prompt",
          runPromptImpl: async () => "direct result",
        }),
      ).resolves.toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith("direct result\n");
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
  });

  it("uses and closes an injected persistent Agent Session", async () => {
    const stdout = createOutput();
    const close = vi.fn(async () => undefined);
    const agentSession: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close,
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit: vi.fn(async () => ""),
    };

    await expect(
      runNonInteractivePrompt({
        agentSession,
        prompt: "persistent",
        stdout: stdout.stream,
      }),
    ).resolves.toBe(0);
    expect(agentSession.submit).toHaveBeenCalledWith(
      "persistent",
      expect.objectContaining({
        userQuestionHandler: expect.any(Function),
      }),
    );
    expect(close).toHaveBeenCalledWith("prompt_input_exit");
    expect(stdout.read()).toBe("(empty output)\n");
  });
});
