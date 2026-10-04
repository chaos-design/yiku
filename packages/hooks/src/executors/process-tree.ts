import { spawn } from "node:child_process";

export interface ProcessTreeTarget {
  readonly killed: boolean;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessTreeTerminationOptions {
  readonly killGroup?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly spawnTaskkill?: ((pid: number) => void) | undefined;
}

export function terminateProcessTree(
  target: ProcessTreeTarget,
  options: ProcessTreeTerminationOptions = {},
): void {
  const pid = target.pid;

  if (pid === undefined || target.killed) {
    return;
  }

  if ((options.platform ?? process.platform) === "win32") {
    (options.spawnTaskkill ?? defaultTaskkill)(pid);
    return;
  }

  const killGroup = options.killGroup ?? defaultKillGroup;
  try {
    killGroup(pid, "SIGTERM");
  } catch {
    target.kill("SIGTERM");
  }
}

function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

function defaultTaskkill(pid: number): void {
  const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
