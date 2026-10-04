import { describe, expect, it, vi } from "vitest";
import { OpenAIContextSummarizer } from "../../src/openai/context-summarizer.js";
import type { AgentRunner } from "../../src/runtime/types.js";

describe("OpenAIContextSummarizer", () => {
  it("uses the configured model with no tools and forwards the signal", async () => {
    const signal = new AbortController().signal;
    const runner = vi.fn<AgentRunner>(async () => ({
      finalOutput: "compact summary",
      stopReason: "completed",
    }));
    const summarizer = new OpenAIContextSummarizer({
      apiKey: "test-key",
      baseURL: "https://api.example.test/v1",
      model: "gpt-test",
      runner,
    });

    await expect(
      summarizer.summarize({
        customInstructions: "Keep decisions.",
        entries: [
          { content: "question", role: "user" },
          { content: "answer", role: "assistant" },
        ],
        maxChars: 1_000,
        signal,
      }),
    ).resolves.toBe("compact summary");
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseURL: "https://api.example.test/v1",
        maxTurns: 1,
        model: "gpt-test",
        signal,
      }),
    );
    const agent = runner.mock.calls[0]?.[0].agent;
    expect(agent.tools).toEqual([]);
    expect(runner.mock.calls[0]?.[0].prompt).toContain("Keep decisions.");
    expect(runner.mock.calls[0]?.[0].prompt).toContain('"role":"user"');
  });

  it("rejects incomplete stages and non-text output", async () => {
    const incomplete = new OpenAIContextSummarizer({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ stopReason: "max_turns" }),
    });
    await expect(
      incomplete.summarize({
        entries: [{ content: "question", role: "user" }],
        maxChars: 100,
      }),
    ).rejects.toThrow("did not complete");

    const nonText = new OpenAIContextSummarizer({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: { summary: "value" }, stopReason: "completed" }),
    });
    await expect(
      nonText.summarize({
        entries: [{ content: "question", role: "user" }],
        maxChars: 100,
      }),
    ).rejects.toThrow("text output");
  });
});
