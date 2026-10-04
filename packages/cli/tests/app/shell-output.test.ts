import { describe, expect, it } from "vitest";
import { buildShellResultView } from "../../src/app/shell-output.js";
import type { ShellCommandResult } from "../../src/services/index.js";

function shellResult(overrides: Partial<ShellCommandResult> = {}): ShellCommandResult {
  return {
    exitCode: 0,
    stderr: "",
    stdout: "",
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

describe("buildShellResultView", () => {
  it("colors stdout white and stderr red with aligned line colors", () => {
    const view = buildShellResultView(
      shellResult({ stderr: "warn-1\nwarn-2\n", stdout: "out-1\nout-2\n" }),
    );

    expect(view.text).toBe("out-1\nout-2\nwarn-1\nwarn-2");
    expect(view.lineColors).toEqual(["white", "white", "red", "red"]);
  });

  it("marks timed out and truncated notes in yellow", () => {
    const view = buildShellResultView(
      shellResult({ exitCode: null, stdout: "partial\n", timedOut: true, truncated: true }),
    );

    expect(view.text).toBe("partial\n(command timed out)\n(output truncated)");
    expect(view.lineColors).toEqual(["white", "yellow", "yellow"]);
  });

  it("reports an empty successful command with a gray note", () => {
    const view = buildShellResultView(shellResult());

    expect(view.text).toBe("(no output)");
    expect(view.lineColors).toEqual(["gray"]);
  });

  it("reports an empty failing command with a red exit note", () => {
    const view = buildShellResultView(shellResult({ exitCode: 3 }));

    expect(view.text).toBe("(exited with code 3)");
    expect(view.lineColors).toEqual(["red"]);
  });
});
