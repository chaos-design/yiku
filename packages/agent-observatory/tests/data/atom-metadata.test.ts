import { describe, expect, it } from "vitest";
import {
  ATOM_KIND_EXPLANATIONS,
  atomKindDescription,
  atomResponsibility,
} from "../../src/data/atom-metadata.js";

describe("atom metadata", () => {
  it("returns specific responsibilities for fixed atoms", () => {
    expect(
      atomResponsibility({
        key: "task.snapshot",
        kind: "store",
      }),
    ).toContain("持久任务");
    expect(
      atomResponsibility({
        key: "agent.profile",
        kind: "agent",
      }),
    ).toContain("Session Profile");
  });

  it("falls back to the atom kind for dynamic definitions", () => {
    expect(
      atomResponsibility({
        key: "tool.dynamic",
        kind: "tool",
      }),
    ).toBe(atomKindDescription("tool"));
    expect(atomKindDescription("tool")).toContain("外部工具");
  });

  it("defines every supported atom kind once", () => {
    expect(new Set(ATOM_KIND_EXPLANATIONS.map((entry) => entry.kind)).size).toBe(
      ATOM_KIND_EXPLANATIONS.length,
    );
    expect(ATOM_KIND_EXPLANATIONS).toHaveLength(18);
  });
});
