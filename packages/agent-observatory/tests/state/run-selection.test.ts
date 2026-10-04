import { describe, expect, it } from "vitest";
import { automaticRunId } from "../../src/state/run-selection.js";
import type { RunSummary } from "../../src/types.js";

describe("automaticRunId", () => {
  it("selects the latest run on initial load", () => {
    expect(automaticRunId([run("latest")], undefined, true)).toBe("latest");
  });

  it("preserves a manually selected historical run during polling", () => {
    const runs = [run("latest"), run("historical")];

    expect(automaticRunId(runs, "historical", false)).toBeUndefined();
  });

  it("preserves a manual selection when a new run arrives", () => {
    const runs = [run("new"), run("latest"), run("historical")];

    expect(automaticRunId(runs, "historical", false)).toBeUndefined();
  });

  it("follows new runs until the user selects one manually", () => {
    const runs = [run("new"), run("latest")];

    expect(automaticRunId(runs, "latest", true)).toBe("new");
  });

  it("recovers when the selected run is no longer available", () => {
    expect(automaticRunId([run("latest")], "missing", false)).toBe("latest");
  });
});

function run(runId: string): RunSummary {
  return {
    createdAt: "2026-08-01T00:00:00.000Z",
    evalMode: "async",
    eventCount: 1,
    prompt: runId,
    runId,
    source: "external",
    status: "completed",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
