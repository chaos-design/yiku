import type { HostedTool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { ResearchAgent } from "../../src/models/research-agent.js";
import { DEFAULT_RESEARCH_PROMPT } from "../../src/prompts/index.js";

describe("ResearchAgent", () => {
  it("requires externally provided model and agent name", () => {
    expect(() => new ResearchAgent({ agentName: "", model: "gpt-test" })).toThrow(
      "Agent name is required.",
    );
    expect(() => new ResearchAgent({ agentName: "Research Agent", model: "" })).toThrow(
      "Model is required.",
    );
  });

  it("uses the default research prompt and web search tool", () => {
    const agent = new ResearchAgent({
      agentName: "Research Agent",
      model: "gpt-test",
    });
    const tool = agent.tools[0] as HostedTool;

    expect(agent.instructions).toBe(DEFAULT_RESEARCH_PROMPT);
    expect(agent.name).toBe("Research Agent");
    expect(agent.model).toBe("gpt-test");
    expect(tool).toMatchObject({
      name: "web_search",
      providerData: {
        type: "web_search",
      },
      type: "hosted_tool",
    });
    expect(tool.providerData).not.toHaveProperty("search_context_size");
  });

  it("accepts custom instructions and search context size", () => {
    const agent = new ResearchAgent({
      agentName: "  Focused Research Agent  ",
      instructions: "  Research only official sources.  ",
      model: "  gpt-test  ",
      searchContextSize: "high",
    });
    const tool = agent.tools[0] as HostedTool;

    expect(agent.name).toBe("Focused Research Agent");
    expect(agent.model).toBe("gpt-test");
    expect(agent.instructions).toBe("Research only official sources.");
    expect(tool.providerData).toMatchObject({
      search_context_size: "high",
    });
  });
});
