import { describe, expect, it } from "vitest";
import { mergeConfig, mergeEnv } from "../src/merge.js";

describe("mergeConfig", () => {
  it("keeps global keys and lets local keys override recursively", () => {
    const globalConfig = {
      agents: {
        default: "global",
        items: {
          global: { model: "shared" },
          local: { model: "old", skills: ["global"] },
        },
      },
      memory: { enabled: true },
    };
    const localConfig = {
      agents: {
        default: "local",
        items: {
          local: { model: "new", skills: ["local"] },
        },
      },
      runtime: { maxTurnsPerStage: 20 },
    };

    expect(mergeConfig(globalConfig, localConfig)).toEqual({
      agents: {
        default: "local",
        items: {
          global: { model: "shared" },
          local: { model: "new", skills: ["local"] },
        },
      },
      memory: { enabled: true },
      runtime: { maxTurnsPerStage: 20 },
    });
  });

  it("does not retain mutable array or object references", () => {
    const source = { nested: { values: ["one"] } };
    const merged = mergeConfig({}, source);
    (source.nested.values as string[]).push("two");

    expect(merged).toEqual({ nested: { values: ["one"] } });
  });
});

describe("mergeEnv", () => {
  it("uses values from the last source while retaining other keys", () => {
    expect(
      mergeEnv(
        { GLOBAL_ONLY: "global", SHARED: "global" },
        { PROCESS_ONLY: "process", SHARED: "process" },
        { LOCAL_ONLY: "local", SHARED: "local" },
      ),
    ).toEqual({
      GLOBAL_ONLY: "global",
      LOCAL_ONLY: "local",
      PROCESS_ONLY: "process",
      SHARED: "local",
    });
  });
});
