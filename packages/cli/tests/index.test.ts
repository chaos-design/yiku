import { describe, expect, it } from "vitest";
import { runCliRuntime, supportsRawMode } from "../src/index.js";

describe("@yiku/cli entry", () => {
  it("exports the CLI runtime without starting a process", () => {
    expect(runCliRuntime).toBeTypeOf("function");
    expect(supportsRawMode).toBeTypeOf("function");
  });
});
