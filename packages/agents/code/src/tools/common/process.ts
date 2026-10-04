import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function terminateProcessGroup(process: ChildProcessWithoutNullStreams): void {
  if (process.pid === undefined) {
    process.kill("SIGTERM");

    return;
  }

  try {
    globalThis.process.kill(-process.pid, "SIGTERM");
  } catch {
    process.kill("SIGTERM");
  }
}
