import type { SessionSubagentProfile } from "@yiku/agent-orchestrator";
import { describe, expect, it, vi } from "vitest";
import { agentsCommand } from "../../../src/slash-commands/builtin/agents.js";
import type { SlashCommandContext } from "../../../src/slash-commands/types.js";

describe("/agents", () => {
  it("lists and shows Session-scoped Profiles", async () => {
    const profile = subagentProfile();
    const context = {
      listAgents: vi.fn(async () => [profile]),
      showAgent: vi.fn(async () => profile),
    } as unknown as SlashCommandContext;

    await expect(agentsCommand.execute(context, { raw: "", values: [] })).resolves.toMatchObject({
      kind: "success",
      lineColors: ["white", "green"],
      message: expect.stringContaining("• agents/reviewer\n  • /agent:reviewer"),
      title: "Agents (1)",
    });
    await expect(
      agentsCommand.execute(context, { raw: "show profile-1", values: ["show", "profile-1"] }),
    ).resolves.toMatchObject({
      kind: "success",
      message: expect.stringContaining("Deliverable: A review."),
      title: "Agent",
    });
  });

  it("removes and runs Profiles with stable command results", async () => {
    const profile = subagentProfile();
    const removeAgent = vi.fn(async () => undefined);
    const runAgent = vi.fn(async () => ({
      agentId: "agent-1",
      finalOutput: "Review complete.",
      profileId: "profile-1",
      status: "succeeded" as const,
      taskId: "task-1",
    }));
    const context = {
      removeAgent,
      runAgent,
      showAgent: vi.fn(async () => profile),
    } as unknown as SlashCommandContext;

    await expect(
      agentsCommand.execute(context, {
        raw: "remove profile-1",
        values: ["remove", "profile-1"],
      }),
    ).resolves.toEqual({
      kind: "success",
      message: "Removed Subagent Profile profile-1.",
      title: "Agent Removed",
    });
    await expect(
      agentsCommand.execute(context, {
        raw: "run profile-1",
        values: ["run", "profile-1"],
      }),
    ).resolves.toMatchObject({
      kind: "success",
      message: expect.stringContaining("Review complete."),
      title: "Agent Result",
    });
    expect(runAgent).toHaveBeenCalledWith("profile-1", "A review.");
  });

  it("returns usage for invalid subcommands", async () => {
    for (const values of [
      ["unknown"],
      ["list", "extra"],
      ["show"],
      ["show", "profile-1", "extra"],
      ["remove"],
      ["remove", "profile-1", "extra"],
      ["run"],
    ]) {
      await expect(
        agentsCommand.execute({} as SlashCommandContext, {
          raw: values.join(" "),
          values,
        }),
      ).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("Usage: /agents"),
      });
    }
  });

  it("renders empty lists, Skill snapshots, and explicit run prompts", async () => {
    const profile = {
      ...subagentProfile(),
      skillSnapshots: [
        {
          agentTypes: ["code"],
          description: "Review code.",
          digest: "a".repeat(64),
          instructions: "Review.",
          mcpTargets: [],
          name: "review",
          path: "/workspace/review/SKILL.md",
          resolvedAt: "2026-08-08T00:00:00.000Z",
          source: "project" as const,
          version: "1.0.0",
        },
      ],
    };
    const runAgent = vi.fn(async () => ({
      agentId: "agent-1",
      finalOutput: "Done",
      profileId: profile.id,
      status: "succeeded" as const,
      taskId: "task-1",
    }));
    const context = {
      listAgents: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([profile]),
      runAgent,
      showAgent: vi.fn(async () => profile),
    } as unknown as SlashCommandContext;

    await expect(
      agentsCommand.execute(context, { raw: "list", values: ["list"] }),
    ).resolves.toMatchObject({
      message: "No Agent Profiles.",
      title: "Agents (0)",
    });
    await expect(
      agentsCommand.execute(context, { raw: "list", values: ["list"] }),
    ).resolves.toMatchObject({
      message: expect.stringContaining("review"),
    });
    await expect(
      agentsCommand.execute(context, {
        raw: "show profile-1",
        values: ["show", "profile-1"],
      }),
    ).resolves.toMatchObject({
      message: expect.stringContaining("review@1.0.0"),
    });
    await agentsCommand.execute(context, {
      raw: "run profile-1 inspect authentication",
      values: ["run", "profile-1", "inspect", "authentication"],
    });
    expect(runAgent).toHaveBeenCalledWith("profile-1", "inspect authentication");
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
    invocationMode: "manual",
    modelKey: "code",
    name: "reviewer",
    purpose: "code-review",
    role: "Review code.",
    scopes: ["."],
    skillSnapshots: [],
    source: "session",
  };
}
