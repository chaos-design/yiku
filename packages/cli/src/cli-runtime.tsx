import { type RenderOptions, render } from "ink";
import { CliAgentSession, type executeAgentSession } from "./agent-session.js";
import { helpText, parseArgs } from "./args.js";
import { CliRoot } from "./cli-root.js";
import { runNonInteractivePrompt } from "./non-interactive.js";
import {
  CLI_EXIT_CODES,
  type CliOutputFormat,
  JsonOutputWriter,
  NdjsonOutputWriter,
} from "./output/index.js";
import { type RunWebCommandOptions, runWebCommand } from "./web/web-runtime.js";
import {
  type WorkspaceTrustRecord,
  WorkspaceTrustStore,
  type WorkspaceTrustStoreContract,
  workspaceTrustFilePath,
} from "./workspace-trust.js";

type ExecuteSession = typeof executeAgentSession;
type RenderCli = typeof render;
type RunWeb = (options: RunWebCommandOptions) => Promise<number>;

export interface RunCliRuntimeOptions {
  readonly automationAuditFilePath?: string | undefined;
  readonly argv?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly homeDir?: string | undefined;
  readonly renderImpl?: RenderCli | undefined;
  readonly runPromptImpl?: ExecuteSession | undefined;
  readonly runWebImpl?: RunWeb | undefined;
  readonly stderr?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly workspaceTrustStore?: WorkspaceTrustStoreContract | undefined;
}

export async function runCliRuntime(options: RunCliRuntimeOptions = {}): Promise<number> {
  const streams = resolveCliStreams(options);
  const argv = options.argv ?? process.argv.slice(2);
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs(argv);
  } catch (error) {
    const outputFormat = requestedOutputFormat(argv);
    if (outputFormat === undefined) {
      streams.stderr.write(`Error: ${errorMessage(error)}\n`);
    } else {
      writeRuntimeFailure(
        streams,
        outputFormat,
        "CLI_INVALID_ARGUMENT",
        errorMessage(error),
        "failed",
      );
    }
    return CLI_EXIT_CODES.INVALID_ARGUMENT;
  }

  if (parsedArgs.help) {
    streams.stdout.write(helpText);
    return 0;
  }

  if (parsedArgs.command === "web") {
    if (parsedArgs.webStop !== true && !supportsRawMode(streams.stdin)) {
      streams.stderr.write("Error: Yiku Web conversation requires an interactive TTY.\n");
      return CLI_EXIT_CODES.EXECUTION_FAILED;
    }
    try {
      return await (options.runWebImpl ?? runWebCommand)({
        port: parsedArgs.port ?? 4317,
        ...(parsedArgs.webStop !== true
          ? {
              runConversation: (endpoint: string) =>
                runInteractivePrompt({
                  agentEnvironment: {
                    ...(options.environment ?? process.env),
                    YIKU_ATOMIC_STUDIO_URL: endpoint,
                  },
                  prompt: "",
                  renderImpl: options.renderImpl,
                  runPromptImpl: options.runPromptImpl,
                  ...streams,
                }),
            }
          : {}),
        stderr: streams.stderr,
        stdout: streams.stdout,
        ...(parsedArgs.webStop !== undefined ? { stop: parsedArgs.webStop } : {}),
      });
    } catch (error) {
      streams.stderr.write(`Error: ${errorMessage(error)}\n`);
      return CLI_EXIT_CODES.EXECUTION_FAILED;
    }
  }

  if (!supportsRawMode(streams.stdin)) {
    const outputFormat = parsedArgs.outputFormat ?? "text";
    if (!hasNonInteractiveAction(parsedArgs)) {
      writeRuntimeFailure(
        streams,
        outputFormat,
        "CLI_INVALID_ARGUMENT",
        'Provide a prompt argument, for example: yiku "your prompt".',
        "failed",
      );
      return CLI_EXIT_CODES.INVALID_ARGUMENT;
    }
    const workspaceDir = process.cwd();
    const trustStore =
      options.workspaceTrustStore ??
      new WorkspaceTrustStore(workspaceTrustFilePath(options.homeDir));
    let authorization: WorkspaceTrustRecord | undefined;
    try {
      authorization = await trustStore.get(workspaceDir);
    } catch (error) {
      writeRuntimeFailure(
        streams,
        outputFormat,
        "CLI_WORKSPACE_AUTHORIZATION_FAILED",
        errorMessage(error),
        "failed",
      );
      return CLI_EXIT_CODES.WORKSPACE_UNAUTHORIZED;
    }
    if (authorization === undefined) {
      writeRuntimeFailure(
        streams,
        outputFormat,
        "CLI_WORKSPACE_UNAUTHORIZED",
        "Workspace is not authorized. Run Yiku interactively to grant access.",
        "failed",
      );
      return CLI_EXIT_CODES.WORKSPACE_UNAUTHORIZED;
    }
    const session = new CliAgentSession({
      accessMode: authorization.accessMode,
      ...(parsedArgs.agentKey !== undefined ? { agentKey: parsedArgs.agentKey } : {}),
      ...(parsedArgs.continueSession !== undefined
        ? { continueSession: parsedArgs.continueSession }
        : {}),
      cwd: workspaceDir,
      env: options.environment,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      permissionPolicyMode: "external",
      ...(parsedArgs.resumeSessionId !== undefined
        ? { resumeSessionId: parsedArgs.resumeSessionId }
        : {}),
      ...(options.runPromptImpl !== undefined
        ? { runAgentSessionImpl: options.runPromptImpl }
        : {}),
    });
    return runNonInteractivePrompt({
      accessMode: authorization.accessMode,
      agentSession: session,
      ...(parsedArgs.agentKey !== undefined ? { agentKey: parsedArgs.agentKey } : {}),
      ...(parsedArgs.answersFilePath !== undefined
        ? { answersFilePath: parsedArgs.answersFilePath }
        : {}),
      ...(options.automationAuditFilePath !== undefined
        ? { auditFilePath: options.automationAuditFilePath }
        : {}),
      ...(parsedArgs.continueSession !== undefined
        ? { continueSession: parsedArgs.continueSession }
        : {}),
      ...(parsedArgs.initOnly !== undefined ? { initOnly: parsedArgs.initOnly } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      outputFormat,
      ...(parsedArgs.policyFilePath !== undefined
        ? { policyFilePath: parsedArgs.policyFilePath }
        : {}),
      prompt: parsedArgs.prompt,
      ...(parsedArgs.resumeSessionId !== undefined
        ? { resumeSessionId: parsedArgs.resumeSessionId }
        : {}),
      ...(parsedArgs.setupMode !== undefined ? { setupMode: parsedArgs.setupMode } : {}),
      workspaceDir: authorization.workspaceDir,
      ...streams,
    });
  }

  if (parsedArgs.answersFilePath !== undefined || parsedArgs.policyFilePath !== undefined) {
    streams.stderr.write("Error: --answers and --policy are only valid in non-interactive mode.\n");
    return CLI_EXIT_CODES.INVALID_ARGUMENT;
  }

  return runInteractivePrompt({
    ...(parsedArgs.agentKey !== undefined ? { agentKey: parsedArgs.agentKey } : {}),
    ...(parsedArgs.continueSession !== undefined
      ? { continueSession: parsedArgs.continueSession }
      : {}),
    ...(parsedArgs.initOnly !== undefined ? { initOnly: parsedArgs.initOnly } : {}),
    prompt: parsedArgs.prompt,
    ...(parsedArgs.resumeSessionId !== undefined
      ? { resumeSessionId: parsedArgs.resumeSessionId }
      : {}),
    renderImpl: options.renderImpl,
    runPromptImpl: options.runPromptImpl,
    ...(parsedArgs.setupMode !== undefined ? { setupMode: parsedArgs.setupMode } : {}),
    ...streams,
  });
}

export function supportsRawMode(stdin: NodeJS.ReadStream): boolean {
  return stdin.isTTY === true && typeof stdin.setRawMode === "function";
}

interface CliStreams {
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

function resolveCliStreams(options: RunCliRuntimeOptions): CliStreams {
  return {
    stderr: options.stderr ?? process.stderr,
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
  };
}

interface RunInteractivePromptOptions extends CliStreams {
  readonly agentEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly agentKey?: string | undefined;
  readonly continueSession?: boolean | undefined;
  readonly initOnly?: boolean | undefined;
  readonly prompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly renderImpl?: RenderCli | undefined;
  readonly runPromptImpl?: ExecuteSession | undefined;
  readonly setupMode?: "init" | "maintenance" | undefined;
}

async function runInteractivePrompt(options: RunInteractivePromptOptions): Promise<number> {
  let exitCode = 0;
  const app = (options.renderImpl ?? render)(
    <CliRoot
      onExitCode={(code) => {
        exitCode = code;
      }}
      agentEnvironment={options.agentEnvironment}
      agentKey={options.agentKey}
      continueSession={options.continueSession}
      initOnly={options.initOnly}
      prompt={options.prompt}
      resumeSessionId={options.resumeSessionId}
      runPromptImpl={options.runPromptImpl}
      setupMode={options.setupMode}
    />,
    createRenderOptions(options),
  );

  await app.waitUntilExit();

  return exitCode;
}

function createRenderOptions(options: CliStreams): RenderOptions {
  return {
    exitOnCtrlC: false,
    stderr: options.stderr,
    stdin: options.stdin,
    stdout: options.stdout,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeRuntimeFailure(
  streams: CliStreams,
  outputFormat: CliOutputFormat,
  code: string,
  message: string,
  status: "failed",
): void {
  if (outputFormat === "text") {
    streams.stderr.write(`Error: ${message}\n`);
    return;
  }
  const writer =
    outputFormat === "json"
      ? new JsonOutputWriter(streams.stdout)
      : new NdjsonOutputWriter(streams.stdout);
  writer.writeFailure({
    diagnostics: [],
    error: { code, message },
    status,
  });
}

function requestedOutputFormat(argv: readonly string[]): CliOutputFormat | undefined {
  let outputFormat: CliOutputFormat | undefined;
  for (const [index, argument] of argv.entries()) {
    const option =
      argument === "--output" || argument === "--output-format"
        ? argument
        : argument.startsWith("--output=")
          ? "--output"
          : argument.startsWith("--output-format=")
            ? "--output-format"
            : undefined;
    const value =
      option === undefined
        ? undefined
        : argument === option
          ? argv[index + 1]
          : argument.slice(`${option}=`.length);
    if (value === "json" || value === "ndjson" || value === "text") {
      outputFormat = value;
    }
  }
  return outputFormat;
}

function hasNonInteractiveAction(parsedArgs: ReturnType<typeof parseArgs>): boolean {
  return (
    parsedArgs.prompt.length > 0 ||
    parsedArgs.continueSession === true ||
    parsedArgs.resumeSessionId !== undefined ||
    parsedArgs.initOnly === true
  );
}
