import type { Tool } from "@openai/agents";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it } from "vitest";
import { createRegisteredAgent } from "../../src/agents/agent-runtime-metadata.js";
import { ResearchAgentFactory } from "../../src/agents/research-agent-factory.js";
import { run } from "../../src/runtime/run.js";

describe("ResearchAgentFactory", () => {
  it("creates evidence-led Research Agents with host-scoped tools", async () => {
    const factory = new ResearchAgentFactory();
    const created = factory.create({
      agentName: "Research Agent",
      handoffs: [],
      instructions: "Focus on official sources.",
      model: "gpt-test",
      tools: [{ name: "skillInspectTool" } as Tool],
      workspaceDir: "/workspace",
    });

    expect(factory.type).toBe("research");
    expect(created.agent.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "recordEvidenceTool",
      "recordResearchClaimTool",
      "skillInspectTool",
    ]);
    expect(created.agent.tools.map((tool) => tool.name)).not.toContain("bashTool");

    const recordEvidence = created.agent.tools.find((tool) => tool.name === "recordEvidenceTool");
    await recordEvidence?.invoke(
      {} as never,
      JSON.stringify({
        claims: ["The API was released."],
        source_type: "primary",
        title: "Official release",
        url: "https://example.com/release",
        verification: "single-source",
      }),
    );
    await expect(
      created.validateOutput?.(
        "[Official release](https://example.com/release)\n\n## Sources\n- https://example.com/release",
      ),
    ).resolves.toMatchObject({ diagnostics: [], passed: true });
    expect(created.evidenceSnapshot()).toHaveLength(1);
  });

  it("rejects host tools that collide with Research domain tools", () => {
    expect(() =>
      new ResearchAgentFactory().create({
        agentName: "Research Agent",
        handoffs: [],
        model: "gpt-test",
        tools: [{ name: "web_search" } as Tool],
        workspaceDir: "/workspace",
      }),
    ).toThrow("Duplicate tool name: web_search");
  });

  it("normalizes absent instructions and non-string outputs for validation", async () => {
    const created = new ResearchAgentFactory().create({
      agentName: "Research Agent",
      handoffs: [],
      model: "gpt-test",
      tools: [],
      workspaceDir: "/workspace",
    });

    await expect(created.validateOutput?.({ report: "draft" })).resolves.toMatchObject({
      passed: false,
    });
    await expect(created.validateOutput?.(null)).resolves.toMatchObject({
      diagnostics: expect.arrayContaining(["Research report is empty."]),
      passed: false,
    });
  });

  it("emits the Research domain lifecycle through the standard run path", async () => {
    const created = createRegisteredAgent(
      new ResearchAgentFactory(),
      {
        agentName: "Research Agent",
        handoffs: [],
        model: "gpt-test",
        tools: [],
        workspaceDir: "/workspace",
      },
      {
        agentId: "research",
        agentKey: "research",
        agentType: "research",
      },
    );
    const recordEvidence = created.agent.tools.find((tool) => tool.name === "recordEvidenceTool");
    const flow = new AtomicFlowRun({ runId: "research-factory-run" });
    const result = await run(created.agent, "Research the release.", {
      apiKey: "test",
      atomicFlow: flow,
      model: "gpt-test",
      runner: async (input) => {
        input.onEvent?.({
          callId: "search-1",
          summary: "official release",
          title: "Web Search",
          toolName: "web_search",
          type: "tool_called",
        });
        await recordEvidence?.invoke(
          {} as never,
          JSON.stringify({
            claims: ["The API was released."],
            source_type: "primary",
            title: "Official release",
            url: "https://example.com/release",
            verification: "single-source",
          }),
        );
        input.onEvent?.({
          callId: "search-1",
          summary: "search complete",
          title: "Web Search",
          toolName: "web_search",
          type: "tool_output",
        });
        return {
          finalOutput:
            "[Official release](https://example.com/release)\n\n## Sources\n- https://example.com/release",
        };
      },
    });

    expect(result.outputValidation).toMatchObject({
      details: {
        evidenceCount: 1,
        passed: true,
      },
      passed: true,
    });
    expect(
      flow
        .snapshot()
        .events.filter((event) => event.atom.key.startsWith("research."))
        .map((event) => event.atom.key),
    ).toEqual(
      expect.arrayContaining([
        "research.plan",
        "research.query",
        "research.search",
        "research.evidence-record",
        "research.corroborate",
        "research.synthesize",
        "research.citation-validate",
        "research.report",
      ]),
    );
  });
});
