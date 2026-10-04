import { describe, expect, it } from "vitest";
import {
  inferModelContextWindow,
  resolveAgentGraph,
  resolveAgentHookComponents,
  resolveModelConfig,
} from "../../src/config/index.js";

describe("resolveModelConfig", () => {
  it("resolves model config from env and file config", () => {
    expect(
      resolveModelConfig({
        env: {
          LOCAL_API_KEY: "local-key",
        },
        modelKey: "local",
        modelsConfig: {
          models: {
            default: "default",
            items: {
              local: {
                agentName: "Local Agent",
                apiKeyEnv: "LOCAL_API_KEY",
                baseURL: "https://local.test/v1",
                contextWindow: 128000,
                instructions: "Use repo context.",
                name: "gpt-local",
              },
            },
          },
        },
      }),
    ).toEqual({
      agentName: "Local Agent",
      apiKey: "local-key",
      apiKeyEnv: "LOCAL_API_KEY",
      baseURL: "https://local.test/v1",
      contextWindow: 128_000,
      contextWindowSource: "configured",
      instructions: "Use repo context.",
      model: "gpt-local",
      modelKey: "local",
    });
  });

  it("prefers env overrides and validates required values", () => {
    expect(
      resolveModelConfig({
        env: {
          AI_AGENT_NAME: "Env Agent",
          AI_API_KEY: "generic-key",
          AI_BASE_URL: "https://env.test/v1",
          AI_CONTEXT_WINDOW: "64000",
          AI_INSTRUCTIONS: "Env instructions.",
          AI_MODEL: "env-model",
          AI_MODEL_NAME: "gpt-env",
        },
        modelsConfig: {},
      }),
    ).toEqual({
      agentName: "Env Agent",
      apiKey: "generic-key",
      apiKeyEnv: "AI_API_KEY",
      baseURL: "https://env.test/v1",
      contextWindow: 64_000,
      contextWindowSource: "configured",
      instructions: "Env instructions.",
      model: "gpt-env",
      modelKey: "env-model",
    });

    expect(() => resolveModelConfig({ env: {}, modelsConfig: {} })).toThrow("Model is required");
    expect(() =>
      resolveModelConfig({
        env: {
          AI_MODEL: "gpt-test",
        },
        modelsConfig: {},
      }),
    ).toThrow(
      "API key is required. Set OPENAI_API_KEY or AI_API_KEY in ~/.yiku/.env or <workspace>/.env. API keys belong in .env files, not config.yaml.",
    );
    expect(() =>
      resolveModelConfig({
        env: {
          AI_CONTEXT_WINDOW: "0",
          AI_MODEL: "gpt-test",
          OPENAI_API_KEY: "test-key",
        },
        modelsConfig: {},
      }),
    ).toThrow("AI_CONTEXT_WINDOW must be a positive integer.");
    expect(() =>
      resolveModelConfig({
        env: {
          AI_API_KEY_ENV: "CUSTOM_API_KEY",
          AI_MODEL: "gpt-test",
        },
        modelsConfig: {},
      }),
    ).toThrow(
      "API key is required. Set CUSTOM_API_KEY in ~/.yiku/.env or <workspace>/.env. API keys belong in .env files, not config.yaml.",
    );
  });

  it("uses default env names and provider base URL fallbacks", () => {
    expect(
      resolveModelConfig({
        env: {
          AI_MODEL_NAME: "gpt-env-name",
          OPENAI_API_KEY: "openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.test/v1",
        },
        modelsConfig: {
          models: "invalid",
        },
      }),
    ).toEqual({
      agentName: "Yiku Code Agent",
      apiKey: "openai-key",
      apiKeyEnv: "OPENAI_API_KEY",
      baseURL: "https://openai-compatible.test/v1",
      model: "gpt-env-name",
      modelKey: "gpt-env-name",
    });
  });

  it("uses model keys when model item fields are omitted", () => {
    expect(
      resolveModelConfig({
        env: {
          OPENAI_API_KEY: "openai-key",
        },
        modelKey: "minimal",
        modelsConfig: {
          models: {
            items: {
              minimal: {},
            },
          },
        },
      }),
    ).toEqual({
      agentName: "Yiku Code Agent",
      apiKey: "openai-key",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "minimal",
      modelKey: "minimal",
    });
  });

  it("infers context windows for known model names without guessing provider endpoints", () => {
    expect(inferModelContextWindow("openai/gpt-5.5-2026-04-23")).toBe(1_050_000);
    expect(inferModelContextWindow("GPT-5.4-mini")).toBe(400_000);
    expect(inferModelContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(inferModelContextWindow("ep-20260730145110-9dwzl")).toBeUndefined();
    expect(inferModelContextWindow("   ")).toBeUndefined();

    expect(
      resolveModelConfig({
        env: {
          AI_MODEL: "frontier",
          AI_MODEL_NAME: "gpt-5.5",
          OPENAI_API_KEY: "openai-key",
        },
        modelsConfig: {},
      }),
    ).toMatchObject({
      contextWindow: 1_050_000,
      contextWindowSource: "inferred",
      model: "gpt-5.5",
    });
  });
});

describe("resolveAgentGraph", () => {
  it("reads agent definitions and ignores invalid entries", () => {
    const graph = resolveAgentGraph({
      agents: {
        default: "triage",
        items: {
          invalid: "skip",
          triage: {
            delegates: ["reviewer"],
            handoffs: ["history"],
            hookFrontmatter: "---\nhooks: {}\n---",
            instructions: "Route requests.",
            model: "gpt-router",
            name: "Triage Agent",
            skills: ["code"],
            type: "code",
          },
        },
      },
    });

    expect(graph.defaultAgentKey).toBe("triage");
    expect([...graph.items.keys()]).toEqual(["triage"]);
    expect(graph.items.get("triage")).toEqual({
      delegates: ["reviewer"],
      handoffs: ["history"],
      hookFrontmatter: "---\nhooks: {}\n---",
      instructions: "Route requests.",
      key: "triage",
      modelKey: "gpt-router",
      name: "Triage Agent",
      skills: ["code"],
      type: "code",
    });
    expect(resolveAgentHookComponents(graph)).toEqual([
      {
        componentId: "triage",
        content: "---\nhooks: {}\n---",
        type: "agent",
      },
    ]);
  });
});
