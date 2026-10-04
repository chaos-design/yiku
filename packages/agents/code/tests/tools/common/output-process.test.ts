import { describe, expect, it, vi } from "vitest";
import {
  formatAgentOutput,
  formatNumberedLines,
  formatToolError,
  truncateOutput,
  truncateText,
} from "../../../src/tools/common/output.js";
import { terminateProcessGroup } from "../../../src/tools/common/process.js";

describe("output helpers", () => {
  it("formats agent output values", () => {
    expect(formatAgentOutput("done")).toBe("done");
    expect(formatAgentOutput(null)).toBe("");
    expect(formatAgentOutput({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(
      formatAgentOutput({
        toJSON: () => undefined,
      }),
    ).toBe("[object Object]");
  });

  it("truncates output and formats numbered lines", () => {
    expect(truncateText("hello", 10)).toEqual({
      text: "hello",
      truncated: false,
    });
    expect(truncateOutput("hello world", 5)).toBe("hello\n[truncated after 5 characters]");
    expect(formatNumberedLines("", undefined)).toBe("1: ");
    expect(formatNumberedLines("a\nb\n", [2, 2])).toBe("2: b");
  });

  it("formats tool errors", () => {
    expect(formatToolError(new Error("failed"))).toBe("Error: failed");
    expect(formatToolError("failed")).toBe("Error: failed");
  });
});

describe("terminateProcessGroup", () => {
  it("kills the process directly when no pid is available", () => {
    const child = {
      kill: vi.fn(),
      pid: undefined,
    };

    terminateProcessGroup(child as never);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to direct kill when process group termination fails", () => {
    const processKill = vi.spyOn(globalThis.process, "kill").mockImplementation(() => {
      throw new Error("missing group");
    });
    const child = {
      kill: vi.fn(),
      pid: 123,
    };

    try {
      terminateProcessGroup(child as never);
      expect(processKill).toHaveBeenCalledWith(-123, "SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      processKill.mockRestore();
    }
  });
});
