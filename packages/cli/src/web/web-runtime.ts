import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ApiServer,
  type ApiServerOptions,
  resolveWebAssetsDir,
} from "@yiku/agent-observatory/server";
import { WebRegistry } from "./web-registry.js";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_BROWSER_DETECTION_TIMEOUT_MS = 1_250;
const MAX_PORT = 65_535;
const POLL_INTERVAL_MS = 50;

interface WebServer {
  close(): Promise<void>;
  hasBrowserClient?(): boolean;
  start(): Promise<{ readonly host: string; readonly port: number }>;
}

export interface RunWebCommandOptions {
  readonly browserDetectionTimeoutMs?: number | undefined;
  readonly createServer?: ((options: ApiServerOptions) => WebServer) | undefined;
  readonly cwd?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly killProcess?: ((pid: number) => Promise<void> | void) | undefined;
  readonly openBrowser?: ((url: string) => Promise<void>) | undefined;
  readonly port: number;
  readonly registry?: WebRegistry | undefined;
  readonly runConversation?: ((endpoint: string) => Promise<number>) | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly stderr?: NodeJS.WriteStream | undefined;
  readonly stdout?: NodeJS.WriteStream | undefined;
  readonly stop?: boolean | undefined;
}

export async function runWebCommand(options: RunWebCommandOptions): Promise<number> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const registry = options.registry ?? new WebRegistry({ homeDir });

  if (options.stop === true) {
    return stopWebServer(options, registry);
  }
  if (options.runConversation === undefined) {
    throw new Error("Yiku Web requires an interactive conversation callback.");
  }
  return runForegroundWeb(options, options.runConversation);
}

async function runForegroundWeb(
  options: RunWebCommandOptions,
  runConversation: (endpoint: string) => Promise<number>,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const active = await startAvailableWebServer(options);

  stdout.write(`Yiku Web ready: ${active.endpoint}\n`);
  const browserConnected = await waitForBrowserClient(
    active.server,
    options.browserDetectionTimeoutMs ?? DEFAULT_BROWSER_DETECTION_TIMEOUT_MS,
    options.sleep ?? delay,
  );
  if (!browserConnected) {
    await openWebPage(options.openBrowser, active.endpoint, stderr);
  }

  const outcome = await runConversation(active.endpoint).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  const closeError = await active.server.close().then(
    () => undefined,
    (error: unknown) => error,
  );

  if (!outcome.ok) {
    if (closeError !== undefined) {
      stderr.write(`Warning: Could not close Yiku Web cleanly. ${errorMessage(closeError)}\n`);
    }
    throw outcome.error;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  return outcome.value;
}

async function waitForBrowserClient(
  server: WebServer,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  if (server.hasBrowserClient === undefined) {
    return false;
  }
  let elapsedMs = 0;
  for (;;) {
    if (server.hasBrowserClient()) {
      return true;
    }
    if (elapsedMs >= timeoutMs) {
      return false;
    }
    const intervalMs = Math.min(POLL_INTERVAL_MS, timeoutMs - elapsedMs);
    await sleep(intervalMs);
    elapsedMs += intervalMs;
  }
}

async function startAvailableWebServer(
  options: RunWebCommandOptions,
): Promise<{ readonly endpoint: string; readonly server: WebServer }> {
  const createServer = options.createServer ?? ((input) => new ApiServer(input));
  const cwd = resolve(options.cwd ?? process.cwd());

  for (let port = options.port; port <= MAX_PORT; port += 1) {
    const server = createServer({
      homeDir: resolve(options.homeDir ?? homedir()),
      port,
      staticDir: resolveWebAssetsDir(),
      workspaceDir: cwd,
    });
    try {
      const address = await server.start();
      return {
        endpoint: `http://${address.host}:${address.port}`,
        server,
      };
    } catch (error) {
      await server.close().catch(() => undefined);
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  throw new Error(`Yiku Web could not find an available port from ${options.port} to ${MAX_PORT}.`);
}

async function stopWebServer(
  options: RunWebCommandOptions,
  registry: WebRegistry,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const registration = await registry.find();
  if (registration === undefined) {
    if ((await registry.current()) !== undefined) {
      throw new Error("Yiku Web registration exists, but the service is not healthy.");
    }
    stdout.write("Yiku Web is not running.\n");
    return 0;
  }

  try {
    await (options.killProcess ?? terminateProcess)(registration.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    await registry.find();
  }

  await waitForRemoval(
    registry,
    registration.pid,
    options.startupTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    options.sleep ?? delay,
  );
  stdout.write(`Yiku Web stopped: ${registration.endpoint}\n`);
  return 0;
}

async function waitForRemoval(
  registry: WebRegistry,
  pid: number,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await registry.current();
    if (current === undefined || current.pid !== pid) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Yiku Web did not stop within ${timeoutMs}ms.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function openWebPage(
  opener: ((url: string) => Promise<void>) | undefined,
  url: string,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  try {
    await (opener ?? openBrowser)(url);
  } catch (error) {
    stderr.write(
      `Warning: Could not open the browser. Open ${url} manually. ${errorMessage(error)}\n`,
    );
  }
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { args: [url], file: "open" }
      : process.platform === "win32"
        ? { args: ["/d", "/s", "/c", "start", "", url], file: "cmd.exe" }
        : { args: [url], file: "xdg-open" };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });

  await new Promise<void>((resolveSpawn, reject) => {
    child.once("error", reject);
    child.once("spawn", resolveSpawn);
  });
  child.unref();
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
  );
}

function terminateProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
