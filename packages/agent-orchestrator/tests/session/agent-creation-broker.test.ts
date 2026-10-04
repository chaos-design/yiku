import type { UserQuestionRequest } from "@yiku/agent-code";
import { describe, expect, it, vi } from "vitest";
import {
  AgentCreationBroker,
  type AgentCreationError,
} from "../../src/session/agent-creation-broker.js";
import type { AgentProfileDraft, AgentProfileGenerator } from "../../src/session/agent-profile.js";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";
import { createSkillDescriptor } from "../../src/skills/skill-types.js";

describe("AgentCreationBroker", () => {
  it("uses a one-line description without opening the question form", async () => {
    const create = createProfile();
    const generator = generatorReturning(profileDraft());
    const questionHandler = vi.fn();
    const broker = await createBroker({ create, generator });

    const profile = await broker.create(
      { intent: " Review authentication after backend changes " },
      { createdBy: "user", questionHandler },
    );

    expect(questionHandler).not.toHaveBeenCalled();
    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: {
          intent: "Review authentication after backend changes",
        },
      }),
      {},
    );
    expect(profile).toMatchObject({
      invocationMode: "proactive",
      name: "security-reviewer",
      purpose: "code-review",
      scopes: ["packages/agent-orchestrator"],
    });
  });

  it("collects all requirements in one structured three-question form", async () => {
    const create = createProfile();
    const generator = generatorReturning(
      profileDraft({
        scopes: ["packages/agent-orchestrator", "docs"],
        triggerInstructions: "后端逻辑完成后运行",
      }),
    );
    const questionHandler = vi.fn(async (request: UserQuestionRequest) => {
      expect(request).toMatchObject({
        description: expect.stringContaining("subagent"),
        questions: [
          expect.objectContaining({ header: "核心用途", multiSelect: false }),
          expect.objectContaining({ header: "技术范围", multiSelect: true }),
          expect.objectContaining({ header: "主动性", multiSelect: false }),
        ],
        title: "AskUserQuestion(核心用途，技术范围，主动性)",
      });
      return {
        answers: [
          {
            answers: ["代码审查"],
            questionIndex: 0,
            selectedIndexes: [0],
          },
          {
            answers: ["agent-orchestrator", "文档 docs/"],
            questionIndex: 1,
            selectedIndexes: [0, 1],
          },
          {
            answers: ["后端逻辑完成后运行"],
            questionIndex: 2,
            selectedIndexes: [],
          },
        ],
      };
    });
    const broker = await createBroker({ create, generator });

    const profile = await broker.create({}, { createdBy: "agent", questionHandler });

    expect(questionHandler).toHaveBeenCalledOnce();
    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: {
          invocationMode: "proactive",
          purpose: "code-review",
          scopes: ["docs", "packages/agent-orchestrator"],
          triggerInstructions: "后端逻辑完成后运行",
        },
      }),
      {},
    );
    expect(profile.createdBy).toBe("agent");
    expect(profile.skillSnapshots).toEqual([expect.objectContaining({ name: "review" })]);
  });

  it("maps manual and custom-purpose answers without adding a trigger", async () => {
    const generator = generatorReturning(
      profileDraft({
        invocationMode: "manual",
        purpose: "custom",
        scopes: ["custom-area"],
        triggerInstructions: undefined,
      }),
    );
    const broker = await createBroker({ create: createProfile(), generator });

    await broker.create(
      {},
      {
        createdBy: "user",
        questionHandler: async () => ({
          answers: [
            {
              answers: ["架构评审"],
              questionIndex: 0,
              selectedIndexes: [],
            },
            {
              answers: ["custom-area"],
              questionIndex: 1,
              selectedIndexes: [],
            },
            {
              answers: ["手动调用"],
              questionIndex: 2,
              selectedIndexes: [1],
            },
          ],
        }),
      },
    );

    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: {
          invocationMode: "manual",
          purpose: "custom",
          scopes: ["custom-area"],
        },
      }),
      {},
    );
  });

  it("requires either interactive answers or a one-line description", async () => {
    const broker = await createBroker({
      create: createProfile(),
      generator: generatorReturning(profileDraft()),
    });

    await expect(broker.create({}, { createdBy: "user" })).rejects.toMatchObject<
      Partial<AgentCreationError>
    >({
      code: "AGENT_CREATION_INPUT_REQUIRED",
    });
    await expect(
      broker.create(
        {},
        {
          createdBy: "user",
          questionHandler: async () => ({ answers: [] }),
        },
      ),
    ).rejects.toMatchObject<Partial<AgentCreationError>>({
      code: "AGENT_CREATION_INPUT_REQUIRED",
    });
  });

  it("wraps cancellation and generator failures without persisting", async () => {
    const create = createProfile();
    const generator: AgentProfileGenerator = {
      generate: vi.fn(async () => Promise.reject(new Error("invalid model output"))),
    };
    const broker = await createBroker({ create, generator });

    await expect(
      broker.create(
        {},
        {
          createdBy: "user",
          questionHandler: async () => Promise.reject(new Error("cancelled")),
        },
      ),
    ).rejects.toMatchObject<Partial<AgentCreationError>>({
      code: "AGENT_CREATION_CANCELLED",
    });
    await expect(broker.create({ intent: "review" }, { createdBy: "user" })).rejects.toMatchObject<
      Partial<AgentCreationError>
    >({
      code: "AGENT_PROFILE_GENERATION_FAILED",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects creation when no Agent type is available", async () => {
    const broker = new AgentCreationBroker({
      agentTypes: [],
      currentModelKey: "code",
      generator: generatorReturning(profileDraft()),
      modelKeys: ["code"],
      parentAccessMode: "read-only",
      registry: { create: createProfile() },
      scopes: [],
      skillRuntime: await skillRuntime(),
    });

    await expect(broker.create({ intent: "review" }, { createdBy: "user" })).rejects.toMatchObject<
      Partial<AgentCreationError>
    >({
      code: "AGENT_TYPE_UNKNOWN",
    });
  });
});

async function createBroker(options: {
  readonly create: ReturnType<typeof createProfile>;
  readonly generator: AgentProfileGenerator;
}) {
  return new AgentCreationBroker({
    agentTypes: ["code"],
    currentModelKey: "code",
    generator: options.generator,
    modelKeys: ["code"],
    parentAccessMode: "read-write",
    registry: { create: options.create },
    scopes: [
      {
        description: "Agent runtime",
        label: "agent-orchestrator",
        path: "packages/agent-orchestrator",
      },
      {
        description: "Documentation",
        label: "文档 docs/",
        path: "docs",
      },
      {
        description: "Whole workspace",
        label: "整个工作区",
        path: ".",
      },
    ],
    skillRuntime: await skillRuntime(),
  });
}

function createProfile() {
  return vi.fn(async (input) => ({
    ...input,
    createdAt: "2026-08-08T00:00:00.000Z",
    id: "profile-1",
    source: "session" as const,
  }));
}

function generatorReturning(draft: AgentProfileDraft): AgentProfileGenerator {
  return {
    generate: vi.fn(async () => draft),
  };
}

function profileDraft(overrides: Partial<AgentProfileDraft> = {}): AgentProfileDraft {
  return {
    accessMode: "read-only",
    agentType: "code",
    deliverable: "A prioritized security review.",
    description: "Review authentication security.",
    instructions: "Review authentication and authorization behavior.",
    invocationMode: "proactive",
    modelKey: "code",
    name: "security-reviewer",
    purpose: "code-review",
    role: "Security reviewer",
    scopes: ["packages/agent-orchestrator"],
    skillNames: ["review"],
    triggerInstructions: "后端逻辑完成后运行",
    ...overrides,
  };
}

async function skillRuntime(): Promise<SkillRuntime> {
  const runtime = new SkillRuntime({
    discovery: async () => ({
      diagnostics: [],
      shadowed: [],
      skills: [
        createSkillDescriptor({
          agentTypes: ["code"],
          description: "Review code.",
          digest: "a".repeat(64),
          instructions: "Review code.",
          mcpTargets: [],
          name: "review",
          path: "/tmp/review/SKILL.md",
          source: "project",
          version: "1.0.0",
        }),
      ],
    }),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  await runtime.discover();
  return runtime;
}
