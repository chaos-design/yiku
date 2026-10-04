import { describe, expect, it } from "vitest";
import { compareHookSources, hookSource } from "../../src/config/source.js";

describe("Hook source", () => {
  it("orders authority before stable path and component keys", () => {
    expect(compareHookSources(hookSource("managed"), hookSource("runtime"))).toBeLessThan(0);
    expect(
      [
        hookSource("plugin", { componentId: "z", path: "/b" }),
        hookSource("plugin", { componentId: "a", path: "/b" }),
        hookSource("plugin", { path: "/a" }),
      ].sort(compareHookSources),
    ).toEqual([
      hookSource("plugin", { path: "/a" }),
      hookSource("plugin", { componentId: "a", path: "/b" }),
      hookSource("plugin", { componentId: "z", path: "/b" }),
    ]);
  });

  it("freezes optional source metadata", () => {
    const source = hookSource("skill", {
      componentId: "review",
      path: "/workspace/SKILL.md",
    });

    expect(source).toEqual({
      componentId: "review",
      path: "/workspace/SKILL.md",
      priority: 200,
      type: "skill",
    });
    expect(Object.isFrozen(source)).toBe(true);
  });
});
