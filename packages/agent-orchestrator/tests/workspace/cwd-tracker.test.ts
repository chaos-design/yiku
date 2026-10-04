import { describe, expect, it, vi } from "vitest";
import { CwdTracker } from "../../src/workspace/cwd-tracker.js";

describe("CwdTracker", () => {
  it("emits real changes and accepts an absolute Hook override", async () => {
    const onChange = vi.fn(async () => "/workspace/approved");
    const tracker = new CwdTracker({
      initialCwd: "/workspace",
      onChange,
    });

    await expect(tracker.update("/workspace/packages")).resolves.toBe("/workspace/approved");
    expect(onChange).toHaveBeenCalledWith({
      newCwd: "/workspace/packages",
      oldCwd: "/workspace",
    });
    expect(tracker.current()).toBe("/workspace/approved");
  });

  it("suppresses duplicates and rejects relative paths", async () => {
    const onChange = vi.fn();
    const tracker = new CwdTracker({
      initialCwd: "/workspace",
      onChange,
    });

    await expect(tracker.update("/workspace")).resolves.toBe("/workspace");
    expect(onChange).not.toHaveBeenCalled();
    await expect(tracker.update("relative")).rejects.toThrow("absolute");
    expect(
      () =>
        new CwdTracker({
          initialCwd: "relative",
          onChange,
        }),
    ).toThrow("absolute");
  });

  it("rejects relative Hook overrides without mutating current state", async () => {
    const tracker = new CwdTracker({
      initialCwd: "/workspace",
      onChange: () => "relative",
    });

    await expect(tracker.update("/workspace/packages")).rejects.toThrow("must return an absolute");
    expect(tracker.current()).toBe("/workspace");
  });
});
