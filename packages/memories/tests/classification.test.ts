import { describe, expect, it } from "vitest";
import { countMemoryClasses, memoryClassForKind } from "../src/classification.js";

describe("memory classification", () => {
  it("projects stored Memory Kinds into scenario, procedure, and semantic classes", () => {
    expect(memoryClassForKind("decision")).toBe("scenario");
    expect(memoryClassForKind("episode")).toBe("scenario");
    expect(memoryClassForKind("procedure")).toBe("procedure");
    expect(memoryClassForKind("fact")).toBe("semantic");
    expect(memoryClassForKind("preference")).toBe("semantic");
    expect(countMemoryClasses(["decision", "episode", "procedure", "fact", "preference"])).toEqual({
      procedure: 1,
      scenario: 2,
      semantic: 2,
    });
  });
});
