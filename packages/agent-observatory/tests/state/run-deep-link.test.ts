import { describe, expect, it } from "vitest";
import { parseRunDeepLink } from "../../src/state/run-deep-link.js";

describe("parseRunDeepLink", () => {
  it("reads a bounded Run ID and Trajectory view", () => {
    expect(parseRunDeepLink("?runId=research-turn-1&view=trajectory")).toEqual({
      runId: "research-turn-1",
      view: "trajectory",
    });
  });

  it("ignores invalid values", () => {
    expect(parseRunDeepLink("?runId=%20&view=raw")).toEqual({
      view: "topology",
    });
    expect(parseRunDeepLink(`?runId=${"x".repeat(129)}&view=topology`)).toEqual({
      view: "topology",
    });
  });
});
