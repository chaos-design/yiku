import { describe, expect, it, vi } from "vitest";
import { OpenAIMemoryExtractor } from "../../src/openai/memory-extractor.js";
import type { AgentRunner } from "../../src/runtime/types.js";

describe("OpenAIMemoryExtractor", () => {
  it("extracts bounded structured drafts with no tools", async () => {
    const signal = new AbortController().signal;
    const runner = vi.fn<AgentRunner>(async () => ({
      finalOutput: JSON.stringify([
        {
          confidence: 0.9,
          content: "Use pnpm for this repository.",
          importance: 0.8,
          kind: "procedure",
          tags: ["tooling"],
        },
      ]),
      stopReason: "completed",
    }));
    const extractor = new OpenAIMemoryExtractor({
      apiKey: "test-key",
      baseURL: "https://api.example.test/v1",
      model: "gpt-test",
      runner,
    });

    await expect(
      extractor.extract(
        {
          context: {
            namespace: "project",
          },
          output: "Tests passed with pnpm.",
          prompt: "Run tests.",
          sessionId: "session-1",
        },
        { signal },
      ),
    ).resolves.toEqual([
      {
        confidence: 0.9,
        content: "Use pnpm for this repository.",
        importance: 0.8,
        kind: "procedure",
        tags: ["tooling"],
      },
    ]);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseURL: "https://api.example.test/v1",
        maxTurns: 1,
        model: "gpt-test",
        signal,
      }),
    );
    expect(runner.mock.calls[0]?.[0].agent.tools).toEqual([]);
    expect(runner.mock.calls[0]?.[0].prompt).toContain("Run tests.");
  });

  it("rejects incomplete, malformed, and oversized extraction output", async () => {
    const input = {
      context: { namespace: "project" },
      output: "output",
      prompt: "prompt",
      sessionId: "session-1",
    };
    const incomplete = new OpenAIMemoryExtractor({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ stopReason: "max_turns" }),
    });
    await expect(incomplete.extract(input)).rejects.toThrow("did not complete");

    const malformed = new OpenAIMemoryExtractor({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: "not json", stopReason: "completed" }),
    });
    await expect(malformed.extract(input)).rejects.toThrow("valid JSON");

    const oversized = new OpenAIMemoryExtractor({
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({
        finalOutput: JSON.stringify(
          Array.from({ length: 21 }, () => ({
            confidence: 1,
            content: "memory",
            importance: 1,
            kind: "fact",
          })),
        ),
        stopReason: "completed",
      }),
    });
    await expect(oversized.extract(input)).rejects.toThrow("at most 20");
  });

  it("accepts direct structured and fenced JSON output", async () => {
    const input = {
      context: { namespace: "project" },
      output: "output",
      prompt: "prompt",
      sessionId: "session-1",
    };
    const draft = {
      confidence: 1,
      content: "Remember this",
      importance: 1,
      kind: "fact" as const,
      metadata: { stable: true },
      tags: ["test"],
    };
    const direct = new OpenAIMemoryExtractor({
      apiKey: "test",
      model: "model",
      runner: async () => ({ finalOutput: [draft], stopReason: "completed" }),
    });
    await expect(direct.extract(input)).resolves.toEqual([draft]);

    const fenced = new OpenAIMemoryExtractor({
      apiKey: "test",
      model: "model",
      runner: async () => ({
        finalOutput: `\`\`\`json\n${JSON.stringify([draft])}\n\`\`\``,
        stopReason: "completed",
      }),
    });
    await expect(fenced.extract(input)).resolves.toEqual([draft]);
  });
});
