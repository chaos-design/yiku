export interface ParsedArgs {
  readonly agentKey?: string | undefined;
  readonly answersFilePath?: string | undefined;
  readonly command?: "web" | undefined;
  readonly continueSession?: boolean | undefined;
  readonly help: boolean;
  readonly initOnly?: boolean | undefined;
  readonly outputFormat?: "json" | "ndjson" | "text" | undefined;
  readonly port?: number | undefined;
  readonly policyFilePath?: string | undefined;
  readonly prompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly setupMode?: "init" | "maintenance" | undefined;
  readonly webStop?: boolean | undefined;
}

const HELP_FLAGS = new Set(["-h", "--help"]);

export const helpText = `Usage:
  yiku [--agent <key>] [--init|--maintenance] "your prompt"
  yiku --resume <session-id> ["follow-up prompt"]
  yiku --continue ["follow-up prompt"]
  yiku web [--port <port>]
  yiku web --stop

Options:
  --agent <key>    Agent graph key from ~/.yiku/config.yaml or ./config.yaml.
  --answers <file> Preconfigured answers keyed by stable questionKey.
  --init            Run project setup before the prompt.
  --init-only       Run project setup and exit.
  --maintenance     Run maintenance setup before the prompt.
  --output <format> Output format: text, json, or ndjson.
  --output-format   Legacy alias for --output.
  --policy <file>   Protected Managed Policy for non-interactive capabilities.
  --resume <id>     Resume a specific unfinished Session.
  --continue        Resume the latest unfinished Session in this workspace.
  --                End option parsing; remaining values form the prompt.
  --port <port>     Web conversation port. Defaults to 4317.
  --stop            Stop a registered legacy Web observer.

Environment:
  YIKU_AGENT       Agent graph key when --agent is not provided.
  AI_MODEL         Model key or model name.
  AI_MODEL_NAME    Provider model name. Also used when AI_MODEL is omitted.
  AI_API_KEY_ENV   Optional API key env var name. Defaults to OPENAI_API_KEY.
  AI_BASE_URL      Optional OpenAI-compatible base URL.
  AI_AGENT_NAME    Optional agent name. Defaults to Yiku Code Agent.
  AI_INSTRUCTIONS  Agent instructions when not provided by config.yaml.
  OPENAI_API_KEY   API key used by default.
  AI_API_KEY       Generic API key fallback.

Files:
  ~/.yiku/config.yaml                          Global models and runtime defaults.
  ~/.yiku/.env                                 Global secrets and variable values.
  ./config.yaml                                Workspace config overrides.
  ./.env                                       Workspace variable overrides.
  ~/.yiku/permission/global.json               Permission profiles and grants.
  ~/.yiku/workspaces/<parent>_<workspace>[_<8-char-hash>]
                                               Runtime Session, logs, and Memory.
  ~/.yiku/web.json                             Legacy Web observer registration.
  ~/.yiku/web.log                              Legacy Web observer logs.

  Legacy Workspace Storage directories with the yiku_ prefix are not scanned or migrated.

Examples:
  yiku "Summarize the current project goals"
  yiku --continue
  yiku --resume session-123 "Continue after review"
  yiku --init-only
  yiku web --port 3333
  yiku web --stop
  AI_MODEL=code yiku "Write a short release note"
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === "web") {
    return parseWebArgs(argv.slice(1));
  }

  let agentKey: string | undefined;
  let answersFilePath: string | undefined;
  let continueSession: boolean | undefined;
  let initOnly: boolean | undefined;
  let outputFormat: ParsedArgs["outputFormat"];
  let policyFilePath: string | undefined;
  let resumeSessionId: string | undefined;
  let setupMode: ParsedArgs["setupMode"];
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--") {
      promptParts.push(...argv.slice(index + 1));
      break;
    }

    if (HELP_FLAGS.has(arg)) {
      return {
        ...(agentKey !== undefined ? { agentKey } : {}),
        help: true,
        ...(initOnly !== undefined ? { initOnly } : {}),
        prompt: "",
        ...(setupMode !== undefined ? { setupMode } : {}),
      };
    }

    if (arg === "--init" || arg === "--init-only") {
      if (setupMode === "maintenance") {
        throw new Error("--init and --maintenance cannot be used together.");
      }
      setupMode = "init";
      initOnly = arg === "--init-only";
      continue;
    }

    if (arg === "--maintenance") {
      if (setupMode === "init") {
        throw new Error("--init and --maintenance cannot be used together.");
      }
      setupMode = "maintenance";
      initOnly = false;
      continue;
    }

    if (arg === "--output" || arg === "--output-format") {
      rejectDuplicateOutputFormat(outputFormat);
      outputFormat = parseOutputFormat(argv[index + 1], arg);
      index += 1;
      continue;
    }

    if (arg === "--answers") {
      rejectDuplicateFileOption(answersFilePath, "--answers");
      answersFilePath = parseFilePath(argv[index + 1], "--answers");
      index += 1;
      continue;
    }

    if (arg.startsWith("--answers=")) {
      rejectDuplicateFileOption(answersFilePath, "--answers");
      answersFilePath = parseFilePath(arg.slice("--answers=".length), "--answers");
      continue;
    }

    if (arg === "--policy") {
      rejectDuplicateFileOption(policyFilePath, "--policy");
      policyFilePath = parseFilePath(argv[index + 1], "--policy");
      index += 1;
      continue;
    }

    if (arg.startsWith("--policy=")) {
      rejectDuplicateFileOption(policyFilePath, "--policy");
      policyFilePath = parseFilePath(arg.slice("--policy=".length), "--policy");
      continue;
    }

    if (arg.startsWith("--output=") || arg.startsWith("--output-format=")) {
      rejectDuplicateOutputFormat(outputFormat);
      const option = arg.startsWith("--output=") ? "--output" : "--output-format";
      outputFormat = parseOutputFormat(arg.slice(`${option}=`.length), option);
      continue;
    }

    if (arg === "--continue") {
      if (resumeSessionId !== undefined) {
        throw new Error("--resume and --continue cannot be used together.");
      }
      continueSession = true;
      continue;
    }

    if (arg === "--resume") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error("--resume requires a Session ID.");
      }
      if (continueSession === true) {
        throw new Error("--resume and --continue cannot be used together.");
      }
      resumeSessionId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      if (!value) {
        throw new Error("--resume requires a Session ID.");
      }
      if (continueSession === true) {
        throw new Error("--resume and --continue cannot be used together.");
      }
      resumeSessionId = value;
      continue;
    }

    if (arg === "--agent") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error("--agent requires an Agent key.");
      }
      agentKey = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length).trim();
      if (!value) {
        throw new Error("--agent requires an Agent key.");
      }
      agentKey = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown yiku option: ${arg}`);
    }

    promptParts.push(arg);
  }

  return {
    ...(agentKey !== undefined ? { agentKey } : {}),
    ...(answersFilePath !== undefined ? { answersFilePath } : {}),
    ...(continueSession !== undefined ? { continueSession } : {}),
    help: false,
    ...(initOnly !== undefined ? { initOnly } : {}),
    ...(outputFormat !== undefined ? { outputFormat } : {}),
    ...(policyFilePath !== undefined ? { policyFilePath } : {}),
    prompt: promptParts.join(" ").trim(),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(setupMode !== undefined ? { setupMode } : {}),
  };
}

function parseFilePath(value: string | undefined, option: "--answers" | "--policy"): string {
  const path = value?.trim();
  if (!path || path.startsWith("--")) {
    throw new Error(`${option} requires a file path.`);
  }
  return path;
}

function rejectDuplicateFileOption(
  current: string | undefined,
  option: "--answers" | "--policy",
): void {
  if (current !== undefined) {
    throw new Error(`${option} may only be provided once.`);
  }
}

function rejectDuplicateOutputFormat(current: ParsedArgs["outputFormat"]): void {
  if (current !== undefined) {
    throw new Error("--output may only be provided once.");
  }
}

function parseOutputFormat(
  value: string | undefined,
  option: "--output" | "--output-format",
): "json" | "ndjson" | "text" {
  if (value !== "json" && value !== "ndjson" && value !== "text") {
    throw new Error(`${option} must be text, json, or ndjson.`);
  }
  return value;
}

function parseWebArgs(argv: readonly string[]): ParsedArgs {
  let port = 4317;
  let portExplicit = false;
  let webStop = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (HELP_FLAGS.has(arg)) {
      return {
        command: "web",
        help: true,
        port,
        prompt: "",
      };
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--port requires a port number.");
      }
      port = parsePort(value);
      portExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      portExplicit = true;
      continue;
    }
    if (arg === "--stop") {
      webStop = true;
      continue;
    }
    throw new Error(`Unknown yiku web option: ${arg}`);
  }
  if (webStop && portExplicit) {
    throw new Error("--stop cannot be used with --port.");
  }

  return {
    command: "web",
    help: false,
    port,
    prompt: "",
    ...(webStop ? { webStop } : {}),
  };
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return port;
}
