import { describe, expect, it } from "vitest";
import { evalProfileForAgent, resolveEvalConfig } from "../../src/config/eval-config.js";

describe("resolveEvalConfig", () => {
  it("creates enforced Code and Research defaults", () => {
    const config = resolveEvalConfig(undefined);

    expect(config).toMatchObject({
      enabled: true,
      maxConcurrentRuns: 8,
      mode: "enforce",
    });
    expect(evalProfileForAgent(config, "code")).toMatchObject({
      id: "code-default",
      type: "code",
    });
    expect(evalProfileForAgent(config, "research")).toMatchObject({
      freshnessDays: 180,
      id: "research-default",
      minimumIndependentDomains: 2,
      type: "research",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.profiles)).toBe(true);
  });

  it("strictly resolves custom Code commands and global policy", () => {
    const config = resolveEvalConfig({
      enabled: true,
      maxConcurrentRuns: 4,
      maxRepairAttempts: 0,
      mode: "observe",
      profile: "ci-code",
      profiles: {
        "ci-code": {
          commands: [
            {
              args: ["pnpm", "lint"],
              command: "corepack",
              id: "lint",
              timeoutMs: 120_000,
              writePolicy: "read-only",
            },
          ],
          maxConcurrentChecks: 2,
          qualityThreshold: 0.9,
          requireChanges: false,
          type: "code",
        },
      },
      timeoutMs: 300_000,
    });
    const profile = evalProfileForAgent(config, "code");

    expect(profile).toMatchObject({
      commands: [
        {
          args: ["pnpm", "lint"],
          command: "corepack",
          cwd: ".",
          envAllowlist: ["PATH"],
          id: "lint",
          network: "deny",
          timeoutMs: 120_000,
          writePolicy: "read-only",
        },
      ],
      id: "ci-code",
      profile: {
        limits: {
          maxConcurrentChecks: 2,
          maxRepairAttempts: 0,
          timeoutMs: 300_000,
        },
        mode: "observe",
        qualityThreshold: 0.9,
      },
      requireChanges: false,
      type: "code",
    });
  });

  it("resolves Research freshness and diversity settings", () => {
    const config = resolveEvalConfig({
      profiles: {
        research: {
          freshnessDays: 30,
          minimumIndependentDomains: 3,
          type: "research",
        },
      },
      profile: "research",
    });

    expect(evalProfileForAgent(config, "research")).toMatchObject({
      freshnessDays: 30,
      minimumIndependentDomains: 3,
      profile: {
        id: "research",
      },
      type: "research",
    });
  });

  it("rejects unknown fields, invalid references, limits, and duplicate commands", () => {
    expect(() => resolveEvalConfig({ unknown: true })).toThrow(
      "Unknown configuration field: evals.unknown",
    );
    expect(() => resolveEvalConfig({ profile: "missing" })).toThrow("references unknown profile");
    expect(() => resolveEvalConfig({ maxConcurrentRuns: 9 })).toThrow("between 1 and 8");
    expect(() =>
      resolveEvalConfig({
        profiles: {
          code: {
            commands: [
              { command: "true", id: "same" },
              { command: "true", id: "same" },
            ],
            type: "code",
          },
        },
      }),
    ).toThrow("duplicate command ID");
    expect(() =>
      resolveEvalConfig({
        profiles: {
          research: {
            type: "research",
            unknown: true,
          },
        },
      }),
    ).toThrow("Unknown configuration field");
  });

  it("validates all global, profile, and command field shapes", () => {
    for (const invalid of [
      { enabled: "yes" },
      { mode: "blocking" },
      { maxRepairAttempts: 2 },
      { timeoutMs: 0 },
      { profiles: [] },
      { profiles: { custom: { type: "custom" } } },
      { profiles: { code: { maxConcurrentChecks: 0, type: "code" } } },
      { profiles: { code: { qualityThreshold: Number.NaN, type: "code" } } },
      { profiles: { code: { requireChanges: "yes", type: "code" } } },
      { profiles: { research: { freshnessDays: 0, type: "research" } } },
      {
        profiles: {
          research: { minimumIndependentDomains: 0, type: "research" },
        },
      },
    ]) {
      expect(() => resolveEvalConfig(invalid)).toThrow();
    }

    const command = (overrides: Readonly<Record<string, unknown>>) => ({
      profiles: {
        code: {
          commands: [{ command: "corepack", id: "command", ...overrides }],
          type: "code",
        },
      },
    });
    for (const invalid of [
      command({ args: "invalid" }),
      command({ args: [""] }),
      command({ cwd: "" }),
      command({ envAllowlist: "invalid" }),
      command({ envAllowlist: ["PATH", "PATH"] }),
      command({ network: "ask" }),
      command({ timeoutMs: 0 }),
      command({ writePolicy: "host" }),
      command({ unknown: true }),
    ]) {
      expect(() => resolveEvalConfig(invalid)).toThrow();
    }
  });
});
