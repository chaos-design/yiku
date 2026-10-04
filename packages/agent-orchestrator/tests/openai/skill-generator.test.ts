import { describe, expect, it, vi } from "vitest";
import { OpenAISkillGenerator } from "../../src/openai/skill-generator.js";
import type { AgentRunner } from "../../src/runtime/types.js";

describe("OpenAISkillGenerator", () => {
  it("runs the current model once and validates JSON output", async () => {
    const runner: AgentRunner = vi.fn(async () => ({
      finalOutput: JSON.stringify({
        description: "Reviews code. Invoke when code changes need review.",
        instructions: "Inspect the diff and report findings by severity.",
        name: "code-review",
      }),
      stopReason: "completed",
    }));
    const generator = new OpenAISkillGenerator({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "gpt-test",
      runner,
    });
    const signal = new AbortController().signal;

    await expect(generator.generate("创建代码审查技能", { signal })).resolves.toMatchObject({
      name: "code-review",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        maxTurns: 1,
        model: "gpt-test",
        prompt: expect.stringContaining("创建代码审查技能"),
        signal,
      }),
    );
  });

  it("rejects invalid JSON, invalid drafts, and incomplete model runs", async () => {
    const invalidJson = new OpenAISkillGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: "not json", stopReason: "completed" }),
    });
    const invalidDraft = new OpenAISkillGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({
        finalOutput: JSON.stringify({
          description: "Review.",
          instructions: "Review.",
          name: "Invalid Name",
        }),
        stopReason: "completed",
      }),
    });
    const stopped = new OpenAISkillGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ stopReason: "max_turns" }),
    });

    await expect(invalidJson.generate("review")).rejects.toThrow("valid JSON");
    await expect(invalidDraft.generate("review")).rejects.toThrow();
    await expect(stopped.generate("review")).rejects.toThrow("did not complete");
  });

  it("accepts direct and fenced model output with an implicit completed stop reason", async () => {
    const draft = {
      description: "Reviews code. Invoke when code changes need review.",
      instructions: "Inspect the diff.",
      name: "code-review",
    };
    const direct = new OpenAISkillGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: draft }),
    });
    const fenced = new OpenAISkillGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({
        finalOutput: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``,
        stopReason: "completed",
      }),
    });

    await expect(direct.generate("review")).resolves.toEqual(draft);
    await expect(fenced.generate("review")).resolves.toEqual(draft);
    expect(
      new OpenAISkillGenerator({
        apiKey: "test-key",
        model: "gpt-test",
      }),
    ).toBeInstanceOf(OpenAISkillGenerator);
  });
});
