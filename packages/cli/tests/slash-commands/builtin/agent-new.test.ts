import { describe, expect, it, vi } from "vitest";
import { agentNewCommand } from "../../../src/slash-commands/builtin/agent-new.js";
import type { SlashCommandContext } from "../../../src/slash-commands/types.js";

describe("/agent-new", () => {
  it("creates a Session-scoped Profile with the raw intent", async () => {
    const createAgent = vi.fn(async () => ({
      accessMode: "read-only" as const,
      agentType: "code",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "user" as const,
      deliverable: "A review.",
      description: "Review code.",
      id: "profile-1",
      instructions: "Review.",
      invocationMode: "proactive" as const,
      modelKey: "code",
      name: "reviewer",
      purpose: "code-review" as const,
      role: "Review code.",
      scopes: ["packages/agent-orchestrator"],
      skillSnapshots: [],
      source: "user" as const,
    }));

    await expect(
      agentNewCommand.execute({ createAgent } as unknown as SlashCommandContext, {
        raw: 'review "authentication"',
        values: ["review", "authentication"],
      }),
    ).resolves.toMatchObject({
      kind: "success",
      lineColors: ["white", "white", "green"],
      message: expect.stringContaining("Command: /agent:reviewer"),
      title: "Agent Created",
    });
    expect(createAgent).toHaveBeenCalledWith('review "authentication"');
  });

  it("uses an undefined intent and formats selected Skill snapshots", async () => {
    const createAgent = vi.fn(async () => ({
      accessMode: "read-write" as const,
      agentType: "research",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "user" as const,
      deliverable: "A report.",
      description: "Research evidence.",
      id: "profile-2",
      instructions: "Research.",
      invocationMode: "manual" as const,
      modelKey: "research",
      name: "researcher",
      purpose: "code-research" as const,
      role: "Research evidence.",
      scopes: ["."],
      skillSnapshots: [{ name: "research" }],
      source: "session" as const,
    }));

    await expect(
      agentNewCommand.execute({ createAgent } as unknown as SlashCommandContext, {
        raw: "   ",
        values: [],
      }),
    ).resolves.toMatchObject({
      message: expect.stringContaining("Skills: research"),
    });
    expect(createAgent).toHaveBeenCalledWith(undefined);
  });
});
