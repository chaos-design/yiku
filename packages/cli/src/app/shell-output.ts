import type { ShellCommandResult } from "../services/index.js";
import type { MessageColor } from "./types.js";

export interface ShellResultView {
  readonly lineColors: readonly MessageColor[];
  readonly text: string;
}

/**
 * Builds the timeline text for a `!` shell command result together with a
 * per-line color map so stdout, stderr, and status notes render distinctly.
 */
export function buildShellResultView(result: ShellCommandResult): ShellResultView {
  const lines: string[] = [];
  const lineColors: MessageColor[] = [];
  const pushSection = (section: string, color: MessageColor) => {
    for (const line of section.split("\n")) {
      lines.push(line);
      lineColors.push(color);
    }
  };

  const stdout = result.stdout.replace(/\n$/, "");
  const stderr = result.stderr.replace(/\n$/, "");
  if (stdout) {
    pushSection(stdout, "white");
  }
  if (stderr) {
    pushSection(stderr, "red");
  }
  if (result.timedOut) {
    pushSection("(command timed out)", "yellow");
  }
  if (result.truncated) {
    pushSection("(output truncated)", "yellow");
  }
  if (lines.length === 0) {
    pushSection(
      result.exitCode === 0 ? "(no output)" : `(exited with code ${result.exitCode})`,
      result.exitCode === 0 ? "gray" : "red",
    );
  }

  return { lineColors, text: lines.join("\n") };
}
