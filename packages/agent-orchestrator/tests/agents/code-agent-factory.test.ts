import type { Tool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { CodeAgentFactory } from "../../src/agents/code-agent-factory.js";

describe("CodeAgentFactory", () => {
  it("creates Code Agents with rendered workspace instructions and tools", async () => {
    const factory = new CodeAgentFactory();
    const tool = { name: "reviewTool" } as Tool;
    const result = factory.create({
      agentName: "Reviewer",
      handoffs: [],
      instructions: "Review behavior.",
      model: "gpt-test",
      tools: [tool],
      workspaceDir: "/workspace",
    });

    expect(factory.type).toBe("code");
    expect(result.agent.name).toBe("Reviewer");
    expect(result.agent.tools).toEqual([tool]);
    await expect(result.agent.getSystemPrompt({} as never)).resolves.toContain("Review behavior.");
    await expect(result.agent.getSystemPrompt({} as never)).resolves.toContain("/workspace");
  });
});
