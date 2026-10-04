import { describe, expect, it, vi } from "vitest";
import { OpenAIAgentProfileGenerator } from "../../src/openai/agent-profile-generator.js";
import type { AgentRunner } from "../../src/runtime/types.js";
import type { AgentProfileGenerationInput } from "../../src/session/agent-profile.js";

describe("OpenAIAgentProfileGenerator", () => {
  it("runs the current model once and validates JSON output", async () => {
    const runner: AgentRunner = vi.fn(async () => ({
      finalOutput: JSON.stringify({
        accessMode: "read-only",
        agentType: "code",
        deliverable: "A review.",
        description: "Review code.",
        instructions: "Review.",
        invocationMode: "manual",
        modelKey: "code",
        name: "code-reviewer",
        purpose: "code-review",
        role: "Reviewer.",
        scopes: ["."],
        skillNames: [],
      }),
      stopReason: "completed",
    }));
    const generator = new OpenAIAgentProfileGenerator({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "gpt-test",
      runner,
    });
    const signal = new AbortController().signal;

    await expect(generator.generate(input(), { signal })).resolves.toMatchObject({
      name: "code-reviewer",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        maxTurns: 1,
        model: "gpt-test",
        prompt: expect.stringContaining('"intent": "Review code"'),
        signal,
      }),
    );
  });

  it("rejects invalid JSON and incomplete model runs", async () => {
    const invalidJson = new OpenAIAgentProfileGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: "not json", stopReason: "completed" }),
    });
    const stopped = new OpenAIAgentProfileGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ stopReason: "max_turns" }),
    });

    await expect(invalidJson.generate(input())).rejects.toThrow("valid JSON");
    await expect(stopped.generate(input())).rejects.toThrow("did not complete");
  });
});

function input(): AgentProfileGenerationInput {
  return {
    agentTypes: ["code"],
    availableScopes: [
      {
        description: "Whole workspace.",
        label: "整个工作区",
        path: ".",
      },
    ],
    currentModelKey: "code",
    modelKeys: ["code"],
    parentAccessMode: "read-write",
    requirements: {
      intent: "Review code",
    },
    skills: [],
  };
}
