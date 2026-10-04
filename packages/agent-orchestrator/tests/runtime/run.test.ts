import { Agent, type Tool } from "@openai/agents";
import { AtomicFlowRun } from "@yiku/atomic-flow";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentProgressEvent,
  type AgentRunner,
  latestUserPrompt,
  type OpenAIAgent,
  registerAgentFactoryResult,
  run,
} from "../../src/index.js";

describe("run", () => {
  it("executes through an injected runner and records trajectory operations", async () => {
    const events: AgentProgressEvent[] = [];
    const hook = vi.fn();
    const runner: AgentRunner = async (input) => {
      input.onEvent?.({
        agentName: "Code Agent",
        type: "agent_updated",
      });
      input.onEvent?.({
        targetAgentName: "Code Agent",
        type: "handoff",
      });
      input.onEvent?.({
        input: { command: "pnpm test" },
        summary: "run pnpm test",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      });
      input.onEvent?.({
        output: "passed",
        summary: "finished passed",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_output",
      });

      return {
        finalOutput: "done",
        usage: {
          cachedInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
          peakInputTokens: 2,
          totalTokens: 5,
        },
      };
    };

    const result = await run({} as OpenAIAgent, "review this", {
      apiKey: "test-key",
      hooks: [
        {
          name: "test",
          onOperation: hook,
        },
      ],
      model: "gpt-test",
      onEvent: (event) => events.push(event),
      runner,
    });

    expect(result.finalOutput).toBe("done");
    expect(events.map((event) => event.type)).toEqual([
      "agent_updated",
      "handoff",
      "tool_called",
      "tool_output",
    ]);
    expect(result.trajectory?.steps.map((step) => step.atomKey)).toEqual(
      expect.arrayContaining(["run", "agent.select", "handoff", "tool.call", "reply.final"]),
    );
    const toolEvents = result.atomicFlow?.events.filter((event) => event.atom.key === "tool.call");
    expect(toolEvents?.find((event) => event.phase === "start")?.payload?.values).toMatchObject({
      input: { command: "pnpm test" },
      toolName: "bashTool",
    });
    expect(toolEvents?.find((event) => event.phase === "end")?.payload?.values).toMatchObject({
      output: "passed",
      toolName: "bashTool",
    });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "run",
        phase: "start",
      }),
      {},
    );
  });

  it("dispatches run error operations before rethrowing", async () => {
    const hook = vi.fn();
    const runner: AgentRunner = async () => {
      throw new Error("runner failed");
    };

    await expect(
      run({} as OpenAIAgent, "review this", {
        apiKey: "test-key",
        hooks: [
          {
            name: "test",
            onOperation: hook,
          },
        ],
        model: "gpt-test",
        runner,
      }),
    ).rejects.toThrow("runner failed");
    expect(hook).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: "runner failed",
        kind: "run",
        phase: "error",
        status: "failed",
      }),
      {},
    );
  });

  it("records one Observer validation result and fails the Atomic Run", async () => {
    const agent = new Agent({
      instructions: "Validate output.",
      model: "gpt-test",
      name: "Validated Agent",
    });
    const output = vi.fn(() => ({
      details: { evidence: 0 },
      diagnostics: ["missing evidence"],
      passed: false,
    }));
    const close = vi.fn();
    registerAgentFactoryResult(
      {
        agent,
        createRunObserver: () => ({
          close,
          error: vi.fn(),
          output,
          progress: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }),
      },
      {
        agentId: "validated",
        agentType: "research",
      },
    );

    const result = await run(agent, "research", {
      apiKey: "test-key",
      model: "gpt-test",
      runner: async () => ({ finalOutput: "draft" }),
    });

    expect(output).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(result.finalOutput).toBe("draft");
    expect(result.outputValidation).toEqual({
      details: { evidence: 0 },
      diagnostics: ["missing evidence"],
      passed: false,
    });
    expect(
      result.atomicFlow?.events.find((event) => event.atom.key === "run" && event.phase === "error")
        ?.payload,
    ).toMatchObject({
      code: "AGENT_OUTPUT_VALIDATION_FAILED",
      summary: "missing evidence",
    });
  });

  it("records model, usage, unmatched tool output, and ignores session progress events", async () => {
    const skillHook = vi.fn();
    const runner: AgentRunner = async (input) => {
      input.onEvent?.({
        agentName: "Code Agent",
        model: "gpt-test",
        prompt: "review this",
        sessionId: "session-1",
        startedAt: "2026-07-31T00:00:00.000Z",
        type: "session_started",
        workspaceDir: "/workspace",
      });
      input.onEvent?.({
        text: "hello",
        type: "message_delta",
      });
      input.onEvent?.({
        type: "reasoning",
      });
      input.onEvent?.({
        summary: "finished orphan output",
        title: "Tool",
        toolName: "unknown",
        type: "tool_output",
      });
      input.onEvent?.({
        model: "gpt-test",
        type: "usage_updated",
        usage: {
          cachedInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
          peakInputTokens: 2,
          totalTokens: 5,
        },
      });
      input.onEvent?.({
        durationMs: 1,
        finishedAt: "2026-07-31T00:00:01.000Z",
        output: "ignored",
        sessionId: "session-1",
        type: "session_finished",
      });

      return {
        finalOutput: "done",
      };
    };

    const result = await run({} as OpenAIAgent, "review this", {
      apiKey: "test-key",
      model: "gpt-test",
      runner,
      skills: [
        {
          hooks: [
            {
              name: "skill-hook",
              onOperation: skillHook,
            },
          ],
          name: "test",
        },
      ],
    });

    expect(result.trajectory?.steps.map((step) => step.atomKey)).toEqual(
      expect.arrayContaining(["run", "model.invoke", "usage.record", "reply.final"]),
    );
    expect(skillHook).toHaveBeenCalled();
  });

  it("forwards optional run settings to the runner", async () => {
    const abortController = new AbortController();
    const runner = vi.fn<AgentRunner>(async () => ({ finalOutput: "done" }));

    await expect(
      run({} as OpenAIAgent, "review this", {
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        maxTurns: 3,
        model: "gpt-test",
        runner,
        signal: abortController.signal,
      }),
    ).resolves.toMatchObject({
      finalOutput: "done",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://example.test/v1",
        maxTurns: 3,
        signal: abortController.signal,
      }),
    );
  });

  it("keeps low-level Project Skill instructions out of the system prompt", async () => {
    const runner = vi.fn<AgentRunner>(async (input) => {
      expect(latestUserPrompt(input.prompt)).toBe("review this");
      expect(JSON.stringify(input.prompt)).toContain("Project review instructions.");
      expect(JSON.stringify(input.prompt)).toContain('trust=\\"untrusted\\"');
      return { finalOutput: "done" };
    });

    await expect(
      run({} as OpenAIAgent, "review this", {
        apiKey: "test-key",
        model: "gpt-test",
        runner,
        skills: [
          {
            digest: "a".repeat(64),
            instructions: "Project review instructions.",
            name: "project-review",
            source: "project",
          },
        ],
      }),
    ).resolves.toMatchObject({ finalOutput: "done" });
  });

  it("clones the Agent and composes runtime and Skill capabilities", async () => {
    const originalTool = { name: "originalTool" } as Tool;
    const runtimeTool = { name: "runtimeTool" } as Tool;
    const skillTool = { name: "skillTool" } as Tool;
    const original = new Agent({
      instructions: async () => "Base instructions.",
      model: "gpt-test",
      name: "Original",
      tools: [originalTool],
    });
    const runner = vi.fn<AgentRunner>(async () => ({ finalOutput: "done" }));

    await run(original, "review this", {
      apiKey: "test-key",
      model: "gpt-test",
      runner,
      skills: [
        {
          instructions: "Use the Skill.",
          name: "test",
          tools: [skillTool],
        },
      ],
      tools: [runtimeTool],
    });

    const executedAgent = runner.mock.calls[0]?.[0].agent as Agent;
    expect(executedAgent).not.toBe(original);
    expect(original.tools).toEqual([originalTool]);
    expect(executedAgent.tools.map((tool) => tool.name)).toEqual([
      "originalTool",
      "runtimeTool",
      "skillTool",
    ]);
    await expect(executedAgent.getSystemPrompt({} as never)).resolves.toBe(
      "Base instructions.\n\nUse the Skill.",
    );
  });

  it("rejects duplicate tool names before invoking the runner", async () => {
    const original = new Agent({
      instructions: "Base instructions.",
      model: "gpt-test",
      name: "Original",
      tools: [{ name: "duplicate" } as Tool],
    });
    const runner = vi.fn<AgentRunner>(async () => ({ finalOutput: "unused" }));

    await expect(
      run(original, "review this", {
        apiKey: "test-key",
        model: "gpt-test",
        runner,
        tools: [{ name: "duplicate" } as Tool],
      }),
    ).rejects.toThrow("Duplicate tool name: duplicate");
    expect(runner).not.toHaveBeenCalled();
  });

  it("records non-error thrown values", async () => {
    const hook = vi.fn();
    const runner: AgentRunner = async () => Promise.reject("string failure");

    await expect(
      run({} as OpenAIAgent, "review this", {
        apiKey: "test-key",
        hooks: [
          {
            name: "test",
            onOperation: hook,
          },
        ],
        model: "gpt-test",
        runner,
      }),
    ).rejects.toBe("string failure");
    expect(hook).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: "string failure",
      }),
      {},
    );
  });

  it("marks aborted runs as cancelled in Atomic Flow", async () => {
    const atomicFlow = new AtomicFlowRun({ runId: "cancelled-run" });
    const controller = new AbortController();
    controller.abort(new Error("User canceled the active task with Escape."));

    await expect(
      run({} as OpenAIAgent, "review this", {
        apiKey: "test-key",
        atomicFlow,
        model: "gpt-test",
        runner: async () => {
          throw controller.signal.reason;
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("User canceled the active task with Escape.");

    expect(
      atomicFlow
        .snapshot()
        .events.find((event) => event.atom.key === "run" && event.phase === "error")?.payload,
    ).toMatchObject({
      code: "AGENT_RUN_CANCELLED",
      summary: "User canceled the active task with Escape.",
    });
  });

  it("emits explicit loop turns and linked runtime atoms", async () => {
    const atomicFlow = new AtomicFlowRun({ runId: "atomic-run" });
    const runner: AgentRunner = async (input) => {
      input.onEvent?.({ agentName: "Code Agent", type: "agent_updated" });
      input.onEvent?.({ text: "thinking", type: "message_delta" });
      input.onEvent?.({
        summary: "call tool",
        title: "Tool",
        toolName: "bashTool",
        type: "tool_called",
      });
      input.onEvent?.({
        summary: "tool done",
        title: "Tool",
        toolName: "bashTool",
        type: "tool_output",
      });
      input.onEvent?.({ text: "final", type: "message_delta" });
      return { finalOutput: "done" };
    };

    const result = await run({} as OpenAIAgent, "prompt", {
      apiKey: "test",
      atomicFlow,
      model: "gpt-test",
      runner,
    });
    const events = result.atomicFlow?.events ?? [];

    expect(
      events.filter((event) => event.atom.key === "loop.turn" && event.phase === "start"),
    ).toHaveLength(2);
    expect(events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "input.prompt",
        "agent.select",
        "model.invoke",
        "action.gate",
        "tool.call",
        "observation",
        "reply.final",
      ]),
    );
    expect(
      events.find((event) => event.atom.key === "model.invoke")?.instance.parentId,
    ).toBeDefined();
    expect(
      events
        .filter((event) => event.phase === "start" && event.edge !== undefined)
        .map((event) => `${event.edge?.fromAtomKey}:${event.edge?.toAtomKey}:${event.edge?.kind}`),
    ).toEqual(
      expect.arrayContaining([
        "run:loop.turn:execution",
        "loop.turn:agent.select:execution",
        "agent.select:model.invoke:execution",
        "model.invoke:action.gate:execution",
        "action.gate:tool.call:execution",
        "tool.call:observation:execution",
        "observation:loop.turn:feedback",
        "action.gate:reply.final:execution",
      ]),
    );
  });

  it("ends active atoms without emitting a final reply when a stage stops", async () => {
    const runner: AgentRunner = async (input) => {
      input.onEvent?.({ text: "partial", type: "message_delta" });
      return {
        continuationState: { marker: "state" } as never,
        stopReason: "max_turns",
      };
    };

    const result = await run({} as OpenAIAgent, "prompt", {
      apiKey: "test",
      model: "gpt-test",
      runner,
    });
    const events = result.atomicFlow?.events ?? [];

    expect(result.stopReason).toBe("max_turns");
    expect(events.some((event) => event.atom.key === "reply.final")).toBe(false);
    expect(
      events.filter((event) => event.atom.key === "model.invoke").map((event) => event.phase),
    ).toEqual(["start", "end"]);
    expect(
      events.find((event) => event.atom.key === "model.invoke" && event.phase === "end")?.payload
        ?.counts,
    ).toEqual({ characters: 7 });
    expect(
      events.filter((event) => event.atom.key === "loop.turn").map((event) => event.phase),
    ).toEqual(["start", "end"]);
  });

  it("aggregates model deltas and shares one model span across parallel tools", async () => {
    const atomicFlow = new AtomicFlowRun({ runId: "model-granularity" });
    const runner: AgentRunner = async (input) => {
      for (let index = 0; index < 100; index += 1) {
        input.onEvent?.({ text: "x", type: "message_delta" });
      }
      input.onEvent?.({ type: "reasoning" });
      for (const callId of ["call-1", "call-2", "call-3"]) {
        input.onEvent?.({
          callId,
          summary: "call tool",
          title: "Tool",
          toolName: "textEditorTool",
          type: "tool_called",
        });
      }
      input.onEvent?.({ type: "reasoning" });
      input.onEvent?.({ text: "ignored", type: "message_delta" });
      for (const callId of ["call-1", "call-2", "call-3"]) {
        input.onEvent?.({
          callId,
          summary: "tool done",
          title: "Tool",
          toolName: "textEditorTool",
          type: "tool_output",
        });
      }
      input.onEvent?.({ text: "final", type: "message_delta" });
      return { finalOutput: "final" };
    };

    const result = await run({} as OpenAIAgent, "prompt", {
      apiKey: "test",
      atomicFlow,
      model: "gpt-test",
      runner,
    });
    const events = result.atomicFlow?.events ?? [];
    const modelEvents = events.filter((event) => event.atom.key === "model.invoke");

    expect(modelEvents.filter((event) => event.phase === "start")).toHaveLength(2);
    expect(modelEvents.filter((event) => event.phase === "delta")).toHaveLength(0);
    expect(modelEvents.filter((event) => event.phase === "end")).toHaveLength(2);
    expect(modelEvents.find((event) => event.phase === "end")?.payload).toMatchObject({
      counts: { characters: 100 },
      values: { reasoning: true },
    });
    expect(
      events.filter((event) => event.atom.key === "tool.call" && event.phase === "start"),
    ).toHaveLength(3);
  });

  it("handles a stopped empty turn and a non-string final output", async () => {
    const stopped = await run({} as OpenAIAgent, "stop", {
      apiKey: "test",
      model: "gpt-test",
      runner: async () => ({ stopReason: "max_turns" }),
    });
    expect(stopped.stopReason).toBe("max_turns");
    expect(stopped.atomicFlow?.events.some((event) => event.atom.key === "model.invoke")).toBe(
      false,
    );

    const cancelled = await run({} as OpenAIAgent, "cancel", {
      apiKey: "test",
      model: "gpt-test",
      runner: async () => ({ stopReason: "cancelled" }),
    });
    expect(
      cancelled.atomicFlow?.events.find(
        (event) => event.atom.key === "run" && event.phase === "error",
      )?.payload,
    ).toMatchObject({
      code: "AGENT_RUN_CANCELLED",
    });

    const completed = await run({} as OpenAIAgent, "object", {
      apiKey: "test",
      model: "gpt-test",
      runner: async (input) => {
        input.onEvent?.({ text: "done", type: "message_delta" });
        return { finalOutput: { done: true } };
      },
    });
    const reply = completed.atomicFlow?.events.find(
      (event) => event.atom.key === "reply.final" && event.phase === "end",
    );
    expect(reply?.payload?.counts).toEqual({ characters: 0 });
    expect(reply?.payload?.values?.output).toEqual({ done: true });
  });

  it("bounds and sanitizes non-JSON tool values without interrupting execution", async () => {
    const cyclic: Record<string, unknown> = {
      bigint: 42n,
      oversized: "x".repeat(40_000),
    };
    cyclic.self = cyclic;
    const result = await run({} as OpenAIAgent, "inspect", {
      apiKey: "test",
      model: "gpt-test",
      runner: async (input) => {
        input.onEvent?.({
          callId: "cyclic",
          input: cyclic,
          summary: "call tool",
          title: "Tool",
          toolName: "customTool",
          type: "tool_called",
        });
        input.onEvent?.({
          callId: "cyclic",
          output: cyclic,
          summary: "tool done",
          title: "Tool",
          toolName: "customTool",
          type: "tool_output",
        });
        input.onEvent?.({
          callId: "null-result",
          input: {},
          summary: "call nullable tool",
          title: "Tool",
          toolName: "nullableTool",
          type: "tool_called",
        });
        input.onEvent?.({
          callId: "null-result",
          output: null,
          summary: "nullable tool done",
          title: "Tool",
          toolName: "nullableTool",
          type: "tool_output",
        });
        return { finalOutput: "done" };
      },
    });
    const toolEvents = result.atomicFlow?.events.filter((event) => event.atom.key === "tool.call");
    const input = toolEvents?.find((event) => event.phase === "start")?.payload?.values?.input;
    const output = toolEvents?.find((event) => event.phase === "end")?.payload?.values?.output;
    const nullOutput = toolEvents?.find(
      (event) => event.phase === "end" && event.payload?.values?.callId === "null-result",
    )?.payload?.values?.output;

    expect(typeof input).toBe("string");
    expect(String(input)).toContain("[truncated after 32000 characters]");
    expect(typeof output).toBe("string");
    expect(String(output)).toContain("[truncated after 32000 characters]");
    expect(nullOutput).toBeNull();
  });

  it("records long-running lifecycle events as bounded Atomic summaries", async () => {
    const runner: AgentRunner = async (input) => {
      input.onEvent?.({
        checkpointRevision: 3,
        sessionStatus: "active",
        stageId: "stage-1",
        type: "checkpoint_saved",
      });
      input.onEvent?.({
        afterEntries: 2,
        beforeEntries: 20,
        type: "context_compacted",
      });
      input.onEvent?.({
        inFlightOperations: 1,
        sessionId: "session-1",
        type: "session_resumed",
      });
      input.onEvent?.({
        stage: 1,
        stageId: "stage-1",
        totalStages: 1,
        type: "stage_started",
      });
      input.onEvent?.({
        agentId: "agent-1",
        agentType: "code",
        profileId: "profile-1",
        taskId: "task-1",
        type: "subagent_spawned",
      });
      input.onEvent?.({
        agentId: "agent-1",
        profileId: "profile-1",
        status: "succeeded",
        taskId: "task-1",
        type: "subagent_result",
      });
      input.onEvent?.({
        blocked: 0,
        completed: 1,
        inProgress: 0,
        pending: 0,
        type: "task_snapshot",
      });
      input.onEvent?.({
        outcome: "completed",
        stageId: "stage-1",
        type: "stage_finished",
      });
      input.onEvent?.({
        questionId: "question-1",
        request: { question: "Continue?" },
        type: "user_question_requested",
      });
      input.onEvent?.({
        questionId: "question-1",
        selectedIndex: 0,
        type: "user_question_resolved",
      });
      input.onEvent?.({
        questionId: "question-2",
        type: "user_question_resolved",
      });
      input.onEvent?.({
        questionId: "question-3",
        reason: "cancelled",
        type: "user_question_cancelled",
      });
      return { finalOutput: "done" };
    };

    const result = await run({} as OpenAIAgent, "prompt", {
      apiKey: "test",
      model: "gpt-test",
      runner,
    });

    expect(result.atomicFlow?.events.map((event) => event.atom.key)).toEqual(
      expect.arrayContaining([
        "context.compact",
        "agent.execute",
        "agent.result",
        "agent.spawn",
        "session.checkpoint",
        "session.resume",
        "stage.finish",
        "stage.start",
        "task.snapshot",
        "user.question",
      ]),
    );
  });
});
