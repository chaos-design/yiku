import type { ToolExecutionMiddleware } from "@yiku/agent-code";
import { describe, expect, it, vi } from "vitest";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";
import { createSkillRuntimeSkill } from "../../src/skills/skill-runtime-skill.js";
import { createSkillDescriptor } from "../../src/skills/skill-types.js";
import { SkillWorker } from "../../src/skills/skill-worker.js";

describe("createSkillRuntimeSkill", () => {
  it("lists, inspects, and runs discovered Skills through strict tools", async () => {
    const runtime = new SkillRuntime({
      discovery: async () => ({
        diagnostics: [],
        shadowed: [],
        skills: [descriptor()],
      }),
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    await runtime.discover();
    const worker = new SkillWorker({
      idGenerator: () => "worker-1",
      run: async ({ prompt }) => `reviewed ${prompt}`,
    });
    const skill = createSkillRuntimeSkill({ runtime, worker });
    const tools = new Map(skill.tools?.map((tool) => [tool.name, tool]));

    expect(skill.instructions).toContain("- review: Review code changes.");
    expect(skill.instructions).not.toContain("Review every changed behavior.");
    const listed = await tools.get("skillListTool")?.invoke({} as never, "{}");
    expect(JSON.parse(String(listed))).toEqual([
      expect.objectContaining({
        name: "review",
        source: "project",
        version: "1.0.0",
      }),
    ]);

    const inspected = await tools
      .get("skillInspectTool")
      ?.invoke({} as never, JSON.stringify({ name: "review" }));
    expect(JSON.parse(String(inspected))).toMatchObject({
      instructions: "Review every changed behavior.",
      name: "review",
      root: "/workspace/review",
    });

    const result = await tools
      .get("skillRunTool")
      ?.invoke({} as never, JSON.stringify({ prompt: "authentication", skill_name: "review" }));
    expect(JSON.parse(String(result))).toMatchObject({
      output: "reviewed authentication",
      skillName: "review",
      status: "succeeded",
    });
  });

  it("returns model-readable errors for missing Skills", async () => {
    const runtime = new SkillRuntime({
      discovery: async () => ({ diagnostics: [], shadowed: [], skills: [] }),
    });
    await runtime.discover();
    const skill = createSkillRuntimeSkill({
      runtime,
      worker: new SkillWorker({ run: async () => "unused" }),
    });
    const inspect = skill.tools?.find((tool) => tool.name === "skillInspectTool");

    await expect(inspect?.invoke({} as never, JSON.stringify({ name: "missing" }))).resolves.toBe(
      "Error: Unknown Skill: missing.",
    );
  });

  it("forwards tool metadata, emits activation events, and truncates inspection", async () => {
    const runtime = new SkillRuntime({
      discovery: async () => ({
        diagnostics: [],
        shadowed: [],
        skills: [descriptor()],
      }),
    });
    await runtime.discover();
    const onEvent = vi.fn();
    const middleware: ToolExecutionMiddleware = {
      run: vi.fn((request) => request.execute(request.validate(request.input))),
    };
    const skill = createSkillRuntimeSkill({
      agentType: "code",
      inspectMaxCharacters: 5,
      middleware,
      onEvent,
      runtime,
      worker: new SkillWorker({
        idGenerator: () => "worker-1",
        run: async () => "done",
      }),
    });
    const tools = new Map(skill.tools?.map((tool) => [tool.name, tool]));
    const details = {
      signal: new AbortController().signal,
      toolCall: { callId: "skill-call-1" } as never,
    };

    await tools.get("skillListTool")?.invoke({} as never, "{}", details);
    const inspected = await tools
      .get("skillInspectTool")
      ?.invoke({} as never, JSON.stringify({ name: "review" }), details);
    await tools
      .get("skillRunTool")
      ?.invoke(
        {} as never,
        JSON.stringify({ prompt: "authentication", skill_name: "review" }),
        details,
      );

    expect(JSON.parse(String(inspected)).instructions).toBe("\n[truncated]");
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "skill_resolved" }),
      expect.objectContaining({ targetId: "skill-call-1", type: "skill_activated" }),
    ]);
    expect(middleware.run).toHaveBeenCalledTimes(3);
  });

  it("validates inspect budgets and uses the default activation target", async () => {
    const runtime = new SkillRuntime({
      discovery: async () => ({
        diagnostics: [],
        shadowed: [],
        skills: [descriptor()],
      }),
    });
    await runtime.discover();

    expect(() =>
      createSkillRuntimeSkill({
        inspectMaxCharacters: 0,
        runtime,
        worker: new SkillWorker({ run: async () => "unused" }),
      }),
    ).toThrow("positive integer");
    expect(() =>
      createSkillRuntimeSkill({
        inspectMaxCharacters: 1.5,
        runtime,
        worker: new SkillWorker({ run: async () => "unused" }),
      }),
    ).toThrow("positive integer");

    const onEvent = vi.fn();
    const skill = createSkillRuntimeSkill({
      onEvent,
      runtime,
      worker: new SkillWorker({ run: async () => "done" }),
    });
    const runTool = skill.tools?.find((tool) => tool.name === "skillRunTool");
    await runTool?.invoke(
      {} as never,
      JSON.stringify({ prompt: "authentication", skill_name: "review" }),
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetId: "skill-worker", type: "skill_activated" }),
    );
  });

  it("fails closed when a Runtime returns no requested Snapshot", async () => {
    const runtime = {
      list: () => [],
      snapshot: () => [],
    } as unknown as SkillRuntime;
    const skill = createSkillRuntimeSkill({
      runtime,
      worker: new SkillWorker({ run: async () => "unused" }),
    });
    const runTool = skill.tools?.find((tool) => tool.name === "skillRunTool");

    await expect(
      runTool?.invoke(
        {} as never,
        JSON.stringify({ prompt: "authentication", skill_name: "missing" }),
      ),
    ).resolves.toBe("Error: Unknown Skill: missing.");
  });
});

function descriptor() {
  return createSkillDescriptor({
    agentTypes: ["code"],
    description: "Review code changes.",
    digest: "a".repeat(64),
    instructions: "Review every changed behavior.",
    mcpTargets: [],
    name: "review",
    path: "/workspace/review/SKILL.md",
    source: "project",
    version: "1.0.0",
  });
}
