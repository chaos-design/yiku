import { describe, expect, it, vi } from "vitest";
import { type ProcessTreeTarget, terminateProcessTree } from "../../src/executors/process-tree.js";

describe("terminateProcessTree", () => {
  it("terminates a POSIX process group", () => {
    const target = processTarget(123);
    const killGroup = vi.fn();

    terminateProcessTree(target, {
      killGroup,
      platform: "darwin",
    });

    expect(killGroup).toHaveBeenCalledWith(123, "SIGTERM");
    expect(target.kill).not.toHaveBeenCalled();
  });

  it("falls back to the child when group termination fails", () => {
    const target = processTarget(123);

    terminateProcessTree(target, {
      killGroup: () => {
        throw new Error("missing group");
      },
      platform: "linux",
    });

    expect(target.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses taskkill on Windows and ignores missing or killed targets", () => {
    const spawnTaskkill = vi.fn();
    terminateProcessTree(processTarget(123), {
      platform: "win32",
      spawnTaskkill,
    });
    terminateProcessTree(processTarget(undefined), {
      platform: "win32",
      spawnTaskkill,
    });
    terminateProcessTree(
      { ...processTarget(123), killed: true },
      {
        platform: "win32",
        spawnTaskkill,
      },
    );

    expect(spawnTaskkill).toHaveBeenCalledOnce();
    expect(spawnTaskkill).toHaveBeenCalledWith(123);
  });
});

function processTarget(pid: number | undefined): ProcessTreeTarget & {
  readonly kill: ReturnType<typeof vi.fn>;
} {
  return {
    kill: vi.fn(() => true),
    killed: false,
    ...(pid !== undefined ? { pid } : {}),
  };
}
