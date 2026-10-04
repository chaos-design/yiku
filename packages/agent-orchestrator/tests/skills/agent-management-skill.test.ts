import type { ToolExecutionMiddleware } from "@yiku/agent-code";
import { describe, expect, it, vi } from "vitest";
import type { SessionSubagentProfile } from "../../src/session/session-state.js";
import { createAgentManagementSkill } from "../../src/skills/agent-management-skill.js";

describe("createAgentManagementSkill", () => {
  it("creates strict list, create, run, and remove tools", async () => {
    const profile = subagentProfile();
    const service = {
      create: vi.fn(async () => profile),
      list: vi.fn(async () => [profile]),
      remove: vi.fn(async () => undefined),
      run: vi.fn(async () => ({
        agentId: "agent-1",
        finalOutput: "done",
        profileId: profile.id,
        status: "succeeded" as const,
        taskId: "task-1",
      })),
      show: vi.fn(async () => profile),
    };
    const skill = createAgentManagementSkill({
      confirmRemove: async () => true,
      profiles: [profile],
      questionHandler: async () => ({ answer: "unused" }),
      service,
    });
    const tools = new Map(skill.tools?.map((tool) => [tool.name, tool]));

    expect(skill.name).toBe("agents");
    expect(skill.instructions).toContain("proactive");
    expect(skill.instructions).toContain("profile-1");
    expect(JSON.parse(String(await tools.get("agentListTool")?.invoke({} as never, "{}")))).toEqual(
      [expect.objectContaining({ id: "profile-1", name: "reviewer" })],
    );
    expect(
      JSON.parse(
        String(
          await tools
            .get("agentCreateTool")
            ?.invoke({} as never, JSON.stringify({ intent: "Review security" })),
        ),
      ),
    ).toMatchObject({ id: "profile-1" });
    expect(
      JSON.parse(
        String(
          await tools
            .get("agentRunTool")
            ?.invoke(
              {} as never,
              JSON.stringify({ profile_id: "profile-1", prompt: "Inspect auth" }),
            ),
        ),
      ),
    ).toMatchObject({ finalOutput: "done", status: "succeeded" });
    await expect(
      tools
        .get("agentRemoveTool")
        ?.invoke({} as never, JSON.stringify({ profile_id: "profile-1" })),
    ).resolves.toBe(JSON.stringify({ profileId: "profile-1", removed: true }));
    expect(service.remove).toHaveBeenCalledWith("profile-1");
  });

  it("fails closed when interactive creation or removal confirmation is unavailable", async () => {
    const profile = subagentProfile();
    const service = {
      create: vi.fn(async () => profile),
      list: vi.fn(async () => [profile]),
      remove: vi.fn(async () => undefined),
      run: vi.fn(),
      show: vi.fn(async () => profile),
    };
    const skill = createAgentManagementSkill({ service });
    const create = skill.tools?.find((tool) => tool.name === "agentCreateTool");
    const remove = skill.tools?.find((tool) => tool.name === "agentRemoveTool");

    await expect(create?.invoke({} as never, "{}")).resolves.toContain(
      "Subagent creation requires an interactive question handler",
    );
    await expect(
      remove?.invoke({} as never, JSON.stringify({ profile_id: "profile-1" })),
    ).resolves.toContain("Subagent removal requires confirmation");
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("forwards metadata through middleware and fails closed when removal is cancelled", async () => {
    const profile = subagentProfile();
    const service = {
      create: vi.fn(async () => profile),
      list: vi.fn(async () => [profile]),
      remove: vi.fn(async () => undefined),
      run: vi.fn(async () => ({
        agentId: "agent-1",
        finalOutput: "done",
        profileId: profile.id,
        status: "succeeded" as const,
        taskId: "task-1",
      })),
      show: vi.fn(async () => profile),
    };
    const middleware: ToolExecutionMiddleware = {
      run: vi.fn((request) => request.execute(request.validate(request.input))),
    };
    const skill = createAgentManagementSkill({
      confirmRemove: async () => false,
      middleware,
      questionHandler: async () => ({ answer: "unused" }),
      service,
    });
    const tools = new Map(skill.tools?.map((tool) => [tool.name, tool]));
    const details = {
      signal: new AbortController().signal,
      toolCall: { callId: "call-1" } as never,
    };

    await tools.get("agentListTool")?.invoke({} as never, "{}", details);
    await tools.get("agentCreateTool")?.invoke({} as never, "{}", details);
    await tools
      .get("agentRunTool")
      ?.invoke({} as never, JSON.stringify({ profile_id: profile.id, prompt: "Inspect" }), details);
    await expect(
      tools
        .get("agentRemoveTool")
        ?.invoke({} as never, JSON.stringify({ profile_id: profile.id }), details),
    ).resolves.toContain("Subagent Profile removal was cancelled");

    expect(middleware.run).toHaveBeenCalledTimes(4);
    expect(middleware.run).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        signal: details.signal,
      }),
    );
    expect(service.create).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ createdBy: "agent" }),
    );
    expect(service.remove).not.toHaveBeenCalled();
  });
});

function subagentProfile(): SessionSubagentProfile {
  return {
    accessMode: "read-only",
    agentType: "code",
    createdAt: "2026-08-08T00:00:00.000Z",
    createdBy: "user",
    deliverable: "A review.",
    description: "Review code.",
    id: "profile-1",
    instructions: "Review.",
    invocationMode: "proactive",
    modelKey: "code",
    name: "reviewer",
    purpose: "code-review",
    role: "Review code.",
    scopes: ["packages/agent-orchestrator"],
    skillSnapshots: [],
    source: "session",
  };
}
