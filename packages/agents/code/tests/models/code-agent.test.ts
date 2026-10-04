import { Agent } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { CodeAgent } from "../../src/models/code-agent.js";
import { codeTools } from "../../src/tools/index.js";

const DEFAULT_TOOL_NAMES = [
  "bashTool",
  "grepTool",
  "lsTool",
  "readTool",
  "editTool",
  "writeTool",
  "todoWriteTool",
  "treeTool",
  "askUserTool",
] as const;

describe("CodeAgent", () => {
  it("requires externally provided model and agent name", () => {
    expect(() => new CodeAgent({ agentName: "", model: "gpt-test" })).toThrow(
      "Agent name is required.",
    );
    expect(() => new CodeAgent({ agentName: "Code Agent", model: "" })).toThrow(
      "Model is required.",
    );
  });

  it("attaches provided tools to the SDK agent", () => {
    const tools = codeTools();
    const agent = new CodeAgent({
      agentName: "Code Agent",
      model: "gpt-test",
      tools,
    });

    expect(agent.tools).toHaveLength(DEFAULT_TOOL_NAMES.length);
    expect(agent.tools.map((tool) => tool.name)).toEqual([...DEFAULT_TOOL_NAMES]);
  });

  it("can create an agent with handoffs", () => {
    const handoff = new Agent({
      name: "Math Tutor",
      model: "gpt-test",
    });
    const agent = new CodeAgent({
      agentName: "Triage Agent",
      handoffs: [handoff],
      model: "gpt-test",
    });

    expect(agent.handoffs).toEqual([handoff]);
  });
});
