import { describe, expect, it } from "vitest";
import { extractProjectPromptInstructions } from "../../src/prompt/project-instructions.js";

describe("extractProjectPromptInstructions", () => {
  it("removes project instructions from config and environment while preserving provenance", () => {
    const config = {
      agents: {
        items: {
          code: {
            instructions: "Project Agent instructions.",
            model: "default",
          },
        },
      },
      models: {
        default: "default",
        items: {
          default: {
            instructions: "Project Model instructions.",
            name: "gpt-test",
          },
        },
      },
    };
    const result = extractProjectPromptInstructions({
      config,
      configPath: "/workspace/config.yaml",
      env: {
        AI_INSTRUCTIONS: "Project environment instructions.",
        OPENAI_API_KEY: "key",
      },
      envPath: "/workspace/.env",
    });

    expect(result.config).toEqual({
      agents: { items: { code: { model: "default" } } },
      models: { default: "default", items: { default: { name: "gpt-test" } } },
    });
    expect(result.env).toEqual({ OPENAI_API_KEY: "key" });
    expect(result.segments).toEqual([
      expect.objectContaining({
        content: "Project Agent instructions.",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceId: "/workspace/config.yaml#agents.items.code.instructions",
        trust: "untrusted",
      }),
      expect.objectContaining({
        content: "Project Model instructions.",
        sourceId: "/workspace/config.yaml#models.items.default.instructions",
      }),
      expect.objectContaining({
        content: "Project environment instructions.",
        sourceId: "/workspace/.env#AI_INSTRUCTIONS",
      }),
    ]);
    expect(config.agents.items.code.instructions).toBe("Project Agent instructions.");
  });

  it("ignores missing and blank instruction values", () => {
    const result = extractProjectPromptInstructions({
      config: {
        agents: { items: { code: { instructions: " " } } },
      },
      configPath: "/workspace/config.yaml",
      env: {},
      envPath: "/workspace/.env",
    });

    expect(result.segments).toEqual([]);
    expect(result.config).toEqual({ agents: { items: { code: {} } } });
  });
});
