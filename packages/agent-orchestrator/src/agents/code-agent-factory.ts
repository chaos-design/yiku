import { CodeAgent, renderCodeAgentPrompt } from "@yiku/agent-code";
import type { AgentFactory, AgentFactoryInput, AgentFactoryResult } from "./types.js";

export class CodeAgentFactory implements AgentFactory {
  public readonly type = "code";

  public create(input: AgentFactoryInput): AgentFactoryResult {
    return {
      agent: new CodeAgent({
        agentName: input.agentName,
        handoffs: [...input.handoffs],
        instructions: renderCodeAgentPrompt({
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          prompt: "",
          workspaceDir: input.workspaceDir,
        }),
        model: input.model,
        tools: [...input.tools],
      }),
    };
  }
}
