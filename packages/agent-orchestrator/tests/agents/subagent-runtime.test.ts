import {
  CallbackHookExecutor,
  type HookCallback,
  HookConfigCompiler,
  HookEngine,
  type HookEventName,
  HookExecutorRegistry,
  HookSession,
  hookSource,
} from "@yiku/hooks";
import { describe, expect, it, vi } from "vitest";
import { SubagentRuntime } from "../../src/agents/subagent-runtime.js";
import { AgentMessageBus } from "../../src/messages/message-bus.js";
import type { AgentMessageEnvelope } from "../../src/messages/types.js";

describe("SubagentRuntime", () => {
  it("publishes correlated native spawn and finish lifecycle messages", async () => {
    const messages: AgentMessageEnvelope[] = [];
    const runtime = new SubagentRuntime({
      eventBase: eventBase(),
      messageBus: new AgentMessageBus({
        sinks: [
          {
            kind: "required",
            publish: (message) => {
              messages.push(message);
            },
          },
        ],
      }),
    });
    const context = {
      agentId: "child-1",
      agentType: "reviewer",
      parentAgentId: "root",
      parentToolCallId: "delegate-1",
      taskId: "task-1",
    } as const;

    await expect(
      runtime.run({
        ...context,
        agentTranscriptPath: "/tmp/agent.jsonl",
        run: async () => "done",
      }),
    ).resolves.toBe("done");
    await runtime.finish(context, "succeeded");

    expect(messages).toEqual([
      expect.objectContaining({
        agentId: "child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: expect.objectContaining({
          agentName: "reviewer",
          agentType: "reviewer",
          kind: "agent_spawned",
          profileId: "reviewer",
        }),
        sessionId: "session-1",
        taskId: "task-1",
      }),
      expect.objectContaining({
        agentId: "child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: {
          agentName: "reviewer",
          kind: "agent_output",
          profileId: "reviewer",
          text: "done",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
      expect.objectContaining({
        agentId: "child-1",
        parentAgentId: "root",
        parentToolCallId: "delegate-1",
        payload: {
          agentName: "reviewer",
          kind: "agent_finished",
          profileId: "reviewer",
          status: "succeeded",
        },
        sessionId: "session-1",
        taskId: "task-1",
      }),
    ]);
  });

  it("emits start/stop and reruns blocked completion with feedback", async () => {
    let stops = 0;
    const run = vi.fn().mockResolvedValueOnce("draft").mockResolvedValueOnce("done");
    const runtime = new SubagentRuntime({
      eventBase: eventBase(),
      hookSession: hookSession({
        SubagentStop: () => {
          stops += 1;
          return stops === 1 ? { action: "block", reason: "verify tests" } : {};
        },
      }),
    });

    await expect(
      runtime.run({
        agentId: "agent-1",
        agentTranscriptPath: "/tmp/agent.jsonl",
        agentType: "reviewer",
        run,
        taskId: "task-1",
      }),
    ).resolves.toBe("done");
    expect(run).toHaveBeenNthCalledWith(1, undefined);
    expect(run).toHaveBeenNthCalledWith(2, "verify tests");
  });

  it("observes subagent start before running", async () => {
    const start = vi.fn(() => ({}));
    const run = vi.fn(async () => "done");
    const runtime = new SubagentRuntime({
      eventBase: eventBase(),
      hookSession: hookSession({
        SubagentStart: start,
      }),
    });

    await expect(
      runtime.run({
        agentId: "agent-1",
        agentTranscriptPath: "/tmp/agent.jsonl",
        agentType: "reviewer",
        run,
        taskId: "task-1",
      }),
    ).resolves.toBe("done");
    expect(start).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs without Hooks and uses fallback feedback for an empty block reason", async () => {
    await expect(
      new SubagentRuntime({ eventBase: eventBase() }).run({
        agentId: "agent-plain",
        agentTranscriptPath: "/tmp/plain.jsonl",
        agentType: "plain",
        run: async () => "plain output",
        taskId: "task-plain",
      }),
    ).resolves.toBe("plain output");

    let stops = 0;
    const run = vi.fn().mockResolvedValueOnce("draft").mockResolvedValueOnce("done");
    const runtime = new SubagentRuntime({
      eventBase: eventBase(),
      hookSession: hookSession({
        SubagentStop: () => {
          stops += 1;
          return stops === 1 ? { action: "block" } : {};
        },
      }),
    });
    await runtime.run({
      agentId: "agent-fallback",
      agentTranscriptPath: "/tmp/fallback.jsonl",
      agentType: "reviewer",
      run,
      taskId: "task-fallback",
    });

    expect(run).toHaveBeenNthCalledWith(2, "Continue the subagent task.");
  });

  it("rejects blocked and stopped starts with explicit or fallback reasons", async () => {
    for (const [action, reason] of [
      ["block", "denied"],
      ["stop", undefined],
    ] as const) {
      const run = vi.fn(async () => "unused");
      const session = hookSession({});
      vi.spyOn(session, "dispatch").mockResolvedValue({
        action,
        additionalContext: [],
        diagnostics: [],
        permissionUpdates: [],
        reasons: reason === undefined ? [] : [reason],
        suppressOutput: false,
        systemMessages: [],
      });
      const runtime = new SubagentRuntime({
        eventBase: eventBase(),
        hookSession: session,
      });

      await expect(
        runtime.run({
          agentId: "agent-blocked",
          agentTranscriptPath: "/tmp/blocked.jsonl",
          agentType: "reviewer",
          run,
          taskId: "task-blocked",
        }),
      ).rejects.toThrow(reason ?? "blocked");
      expect(run).not.toHaveBeenCalled();
    }
  });
});

function hookSession(
  handlers: Readonly<Partial<Record<HookEventName, HookCallback>>>,
): HookSession {
  const hooks = Object.fromEntries(
    Object.entries(handlers).map(([eventName, callback]) => [
      eventName,
      [{ hooks: [{ callback, name: eventName, type: "callback" }] }],
    ]),
  );
  const snapshot = new HookConfigCompiler().compile([
    { source: hookSource("runtime"), value: { hooks } },
  ]).snapshot;
  return new HookSession({
    engine: new HookEngine({
      executors: new HookExecutorRegistry([new CallbackHookExecutor()]),
      snapshot,
    }),
  });
}

function eventBase() {
  return {
    cwd: "/workspace",
    hook_event_name: "SubagentStart",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
  } as const;
}
