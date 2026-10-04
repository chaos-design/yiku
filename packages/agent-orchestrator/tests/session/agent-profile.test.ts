import { describe, expect, it } from "vitest";
import {
  type AgentProfileGenerationInput,
  parseAgentProfileDraft,
  toAgentProfileName,
} from "../../src/session/agent-profile.js";

describe("Agent Profile generation constraints", () => {
  it("normalizes a valid generated Profile", () => {
    const parsed = parseAgentProfileDraft(
      {
        accessMode: "read-only",
        agentType: "code",
        deliverable: "A prioritized review.",
        description: "Review concurrency.",
        instructions: "Report verifiable issues.",
        invocationMode: "proactive",
        modelKey: "code",
        name: "Agent Orchestrator Reviewer",
        purpose: "code-review",
        role: "Review code.",
        scopes: ["packages/agent-orchestrator"],
        skillNames: ["review"],
        triggerInstructions: "后端逻辑完成后运行",
      },
      input(),
    );

    expect(parsed).toMatchObject({
      name: "agent-orchestrator-reviewer",
      scopes: ["packages/agent-orchestrator"],
      skillNames: ["review"],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects privilege escalation and unavailable capabilities", () => {
    const base = {
      accessMode: "read-only",
      agentType: "code",
      deliverable: "A review.",
      description: "Review code.",
      instructions: "Review.",
      invocationMode: "proactive",
      modelKey: "code",
      name: "reviewer",
      purpose: "code-review",
      role: "Reviewer.",
      scopes: ["packages/agent-orchestrator"],
      skillNames: ["review"],
      triggerInstructions: "后端逻辑完成后运行",
    } as const;

    expect(() =>
      parseAgentProfileDraft(
        { ...base, accessMode: "read-write" },
        { ...input(), parentAccessMode: "read-only" },
      ),
    ).toThrow("cannot exceed");
    expect(() => parseAgentProfileDraft({ ...base, agentType: "unknown" }, input())).toThrow(
      "Agent type is not available",
    );
    expect(() => parseAgentProfileDraft({ ...base, skillNames: ["missing"] }, input())).toThrow(
      "unavailable Skill",
    );
  });

  it("rejects model changes to locked form answers", () => {
    const base = {
      accessMode: "read-only",
      agentType: "code",
      deliverable: "A review.",
      description: "Review code.",
      instructions: "Review.",
      invocationMode: "manual",
      modelKey: "code",
      name: "reviewer",
      purpose: "code-review",
      role: "Reviewer.",
      scopes: ["packages/agent-orchestrator"],
      skillNames: [],
    } as const;

    expect(() => parseAgentProfileDraft(base, input())).toThrow(
      "changed the user-selected invocation mode",
    );
    expect(() =>
      parseAgentProfileDraft({ ...base, invocationMode: "proactive", scopes: ["."] }, input()),
    ).toThrow("changed the user-selected scopes");
  });

  it("requires a safe kebab-case-compatible name", () => {
    expect(toAgentProfileName("  Code Reviewer  ")).toBe("code-reviewer");
    expect(() => toAgentProfileName("代码审查")).toThrow("ASCII");
  });
});

function input(): AgentProfileGenerationInput {
  return {
    agentTypes: ["code"],
    availableScopes: [
      {
        description: "Agent runtime.",
        label: "agent-orchestrator",
        path: "packages/agent-orchestrator",
      },
    ],
    currentModelKey: "code",
    modelKeys: ["code"],
    parentAccessMode: "read-write",
    requirements: {
      invocationMode: "proactive",
      purpose: "code-review",
      scopes: ["packages/agent-orchestrator"],
      triggerInstructions: "后端逻辑完成后运行",
    },
    skills: [
      {
        agentTypes: ["code"],
        description: "Review code.",
        digest: "a".repeat(64),
        instructions: "Review.",
        mcpTargets: [],
        name: "review",
        path: "/tmp/review/SKILL.md",
        source: "project",
        version: "1.0.0",
      },
    ],
  };
}
