import {
  type AgentMessageEnvelope,
  type AgentMessagePayload,
  createInitialSessionState,
  type SessionState,
  type UserQuestionResponse,
} from "@yiku/agent-orchestrator";
import type { HookTrustRequest } from "@yiku/hooks";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type {
  CliAgentSessionContract,
  CliAgentSessionSubmitOptions,
  ExecuteAgentSessionOptions,
} from "../src/agent-session.js";
import type { DirectoryChild } from "../src/app/file-search.js";
import { App, getErrorSource, PROMPT_CURSOR, YIKU_LOGO } from "../src/app.js";

const testContext = {
  agentKey: "code",
  agentName: "Playground Agent",
  agentType: "code",
  apiKeyEnv: "OPENAI_API_KEY",
  hasInstructions: true,
  model: "gpt-playground",
  modelKey: "code",
  prompt: "inspect playground",
  sessionId: "test-session",
  sessionsDir: "/tmp/.yiku/workspaces/yiku_tmp_workspace/session",
  traceFilePath: "/tmp/.yiku/workspaces/yiku_tmp_workspace/session/test-session.jsonl",
  transcriptFilePath:
    "/tmp/.yiku/workspaces/yiku_tmp_workspace/session/test-session.transcript.jsonl",
  workspaceDir: "/tmp/playground/react-vite-shadcn",
} as const;

const workspaceEntries: readonly DirectoryChild[] = [
  { isDirectory: true, name: "packages" },
  { isDirectory: true, name: "playground" },
  { isDirectory: false, name: "README.md" },
];

function createReadDirectory() {
  return vi.fn(async (): Promise<readonly DirectoryChild[]> => workspaceEntries);
}

describe("App", () => {
  it("extracts only project frames from Error chains", () => {
    expect(getErrorSource("failure")).toBeUndefined();

    const withoutStack = new Error("without stack");
    withoutStack.stack = undefined;
    expect(getErrorSource(withoutStack)).toBeUndefined();

    const dependencyOnly = new Error("dependency");
    dependencyOnly.stack = [
      "Error: dependency",
      "random stack line",
      "    at dependency (/workspace/node_modules/example/index.js:1:1)",
      "    at external (/workspace/src/example.ts:2:2)",
    ].join("\n");
    expect(getErrorSource(dependencyOnly)).toBeUndefined();

    const project = new Error("project");
    project.stack = ["Error: project", "    at execute (/workspace/packages/example.ts:42:7)"].join(
      "\n",
    );
    expect(getErrorSource(project)).toContain("packages/example.ts:42:7");
  });

  it("keeps reusable terminal UI constants exported", () => {
    expect(PROMPT_CURSOR).toBe("█");
    expect(YIKU_LOGO.join("\n")).toContain("██╗");
  });

  it("passes optional configuration to the default session and file search", async () => {
    const readDirectory = vi.fn(async () => [] as readonly DirectoryChild[]);
    const app = render(
      <App
        agentEnvironment={{ TEST_VALUE: "configured" }}
        agentKey="code"
        autoExit={false}
        prompt=""
        readDirectory={readDirectory}
        runPromptImpl={vi.fn(async () => "unused")}
      />,
    );

    app.stdin.write("@");
    await vi.waitFor(() => {
      expect(readDirectory).toHaveBeenCalled();
    });
    app.unmount();
  });

  it("renders an interactive shell before a task is submitted", () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    expect(app.lastFrame()).toContain("██╗");
    expect(app.lastFrame()).toContain("Ask anything...");
    expect(app.lastFrame()).toContain("> Ask anything...");
    expect(app.lastFrame()).not.toContain("█Ask anything...");
    expect(app.lastFrame()).toContain("@ file search");
    expect(app.lastFrame()).toContain("/ command mode");
    expect(app.lastFrame()).toContain("Model:");
    expect(app.lastFrame()).toContain("Context: unavailable");
    expect(
      app
        .lastFrame()
        ?.split("\n")
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith("╭"))
        .at(-1),
    ).toHaveLength(100);
    expect(runPromptImpl).not.toHaveBeenCalled();

    app.unmount();
  });

  it("renders initial Context progress from the active model before submission", async () => {
    const submit = vi.fn(async () => "not called");
    const agentSession = sessionWithSubmit(submit, {
      currentModel: vi.fn(async () => "code"),
      models: vi.fn(async () => [
        {
          contextWindow: 128_000,
          contextWindowSource: "configured",
          key: "code",
          model: "gpt-code",
        },
      ]),
    });
    const app = render(<App agentSession={agentSession} autoExit={false} prompt="" />);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Model: gpt-code");
      expect(app.lastFrame()).toContain("Context: ░░░░░░░░░░░░░░░░░░░░ 0/128K tokens (0%)");
    });
    expect(submit).not.toHaveBeenCalled();

    app.unmount();
  });

  it("runs interactive init-only without submitting a prompt", async () => {
    const close = vi.fn(async () => undefined);
    const setup = vi.fn(async () => undefined);
    const submit = vi.fn(async () => "unused");
    const agentSession: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close,
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup,
      submit,
    };
    const app = render(
      <App agentSession={agentSession} autoExit={false} initOnly prompt="" setupMode="init" />,
    );

    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledWith(
        "init",
        expect.objectContaining({
          hookTrustApprovalHandler: expect.any(Function),
        }),
      );
      expect(close).toHaveBeenCalledWith("prompt_input_exit");
    });
    expect(submit).not.toHaveBeenCalled();
    app.unmount();
  });

  it("submits typed input through the code-agent prompt runner", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, baseURL: "https://example.test/v1", prompt });

      return Promise.resolve("agent result");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("hello\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("> hello");
      expect(frame).toContain("hello");
      expect(frame).toContain("● agent result");
      expect(frame).toContain("Thought for");
      expect(frame).toContain("@ file search");
      expect(frame).toContain("Model: gpt-playground");
    });

    expect(runPromptImpl).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        onContext: expect.any(Function),
      }),
    );
    app.unmount();
  });

  it("renders code-agent progress events while a task is running", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });
      options?.onEvent?.({ agentName: "Code Agent", type: "agent_updated" });
      options?.onEvent?.({
        sourceAgentName: "Planner",
        targetAgentName: "Coder",
        type: "handoff",
      });
      options?.onEvent?.({ targetAgentName: "Reviewer", type: "handoff" });
      options?.onEvent?.({ type: "reasoning" });
      options?.onEvent?.({ text: "Inspecting", type: "message_delta" });
      options?.onEvent?.({
        input: {
          path: ".",
        },
        summary: "list .",
        title: "Ls",
        toolName: "lsTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "README.md",
        summary: "finished README.md",
        title: "Ls",
        toolName: "lsTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "pnpm build",
        },
        summary: "run pnpm build",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "> yiku build\n> tsc -b",
        summary: "finished build",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "view",
          path: "/workspace/src/index.ts",
        },
        summary: "view /workspace/src/index.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: [
          "import { run } from './run.js';",
          "export { run };",
          "export const ok = true;",
        ].join("\n"),
        summary: "finished read",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "str_replace",
          new_str: "export const ok = true;",
          old_str: "export const ok = false;",
          path: "/workspace/src/index.ts",
        },
        summary: "str_replace /workspace/src/index.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "Successfully replaced text at exactly one location.",
        summary: "finished edit",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        output: "1. [ ] Inspect current output\n2. [-] Beautify TODO display\n3. [x] Add trace",
        summary: "1 pending · 1 in progress · 1 completed · active: Beautify TODO display",
        title: "TodoWrite",
        toolName: "todoWriteTool",
        type: "tool_output",
      });

      return Promise.resolve("Inspecting");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("hello\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("● Inspecting");
      expect(frame).toContain("Agent: Code Agent");
      expect(frame).toContain("Handoff: Planner -> Coder");
      expect(frame).toContain("Handoff: Reviewer");
      expect(frame).not.toContain("Thinking...");
      expect(frame).toContain('● Ls(path: ".")');
      expect(frame).toContain("└ README.md");
      expect(frame).toContain("● Bash(pnpm build)");
      expect(frame).toContain("└ > yiku build");
      expect(frame).toContain("> tsc -b");
      expect(frame).toContain('● Read(file_path: "/workspace/src/index.ts")');
      expect(frame).toContain("└ import { run } from './run.js';");
      expect(frame).toContain("export { run };");
      expect(frame).toContain('● Edit(file_path: "/workspace/src/index.ts")');
      expect(frame).toContain("└ 1 addition(s) and 1 deletion(s)");
      expect(frame).toContain("- export const ok = false;");
      expect(frame).toContain("+ export const ok = true;");
      expect(frame).toContain("└ Status updated: 1 completed, 1 in progress.");
      expect(frame).toContain("├□ Inspect current output");
      expect(frame).toContain("├□ Beautify TODO display");
      expect(frame).toContain("✓ Add trace");
      expect(frame).toContain("Thought for");
    });

    expect(runPromptImpl).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        onEvent: expect.any(Function),
      }),
    );
    app.unmount();
  });

  it("renders bounded long-running lifecycle events and checkpoint status", async () => {
    const runPromptImpl = vi.fn((_prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onEvent?.({
        checkpointRevision: 4,
        sessionStatus: "active",
        stageId: "stage-1",
        type: "checkpoint_saved",
      });
      options?.onEvent?.({
        inFlightOperations: 1,
        sessionId: "session-1",
        type: "session_resumed",
      });
      options?.onEvent?.({
        stage: 1,
        stageId: "stage-1",
        totalStages: 1,
        type: "stage_started",
      });
      options?.onEvent?.({
        afterEntries: 2,
        beforeEntries: 20,
        type: "context_compacted",
      });
      options?.onEvent?.({
        agentId: "agent-1",
        agentType: "code",
        profileId: "profile-1",
        taskId: "task-1",
        type: "subagent_spawned",
      });
      options?.onEvent?.({
        agentId: "agent-1",
        profileId: "profile-1",
        status: "succeeded",
        taskId: "task-1",
        type: "subagent_result",
      });
      options?.onEvent?.({
        blocked: 0,
        completed: 1,
        inProgress: 0,
        pending: 0,
        type: "task_snapshot",
      });
      options?.onEvent?.({
        outcome: "completed",
        stageId: "stage-1",
        type: "stage_finished",
      });
      return Promise.resolve("done");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("long task\r");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Session resumed: session-1");
      expect(frame).toContain("Stage 1 started");
      expect(frame).toContain("Context compacted");
      expect(frame).toContain("Subagent code spawned");
      expect(frame).toContain("Subagent agent-1 succeeded");
      expect(frame).toContain("Agent(profile-1)");
      expect(frame).toContain("Type: code");
      expect(frame).toContain("Task: task-1");
      expect(frame).toContain("Succeeded");
      expect(frame).toContain("Tasks: 1 completed");
      expect(frame).toContain("Stage stage-1 completed");
      expect(frame).toContain("Checkpoint r4");
    });
    app.unmount();
  });

  it("renders parallel child tool envelopes and unsubscribes on unmount", async () => {
    const messageEvents = testAgentMessageSource();
    const app = render(
      <App
        autoExit={false}
        messageEvents={messageEvents.source}
        prompt=""
        runPromptImpl={vi.fn(async () => "unused")}
        staticTranscript
      />,
    );

    await vi.waitFor(() => {
      expect(messageEvents.listenerCount()).toBe(1);
    });

    messageEvents.publish(
      agentEnvelope(
        "child-a",
        { agentType: "code", kind: "agent_spawned", profileId: "code-reviewer" },
        {
          occurredAt: "2026-08-10T00:00:00.000Z",
          parentAgentId: "root",
          parentToolCallId: "delegate-a",
          taskId: "task-a",
        },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-b",
        { agentType: "code", kind: "agent_spawned", profileId: "test-runner" },
        {
          occurredAt: "2026-08-10T00:00:01.000Z",
          parentAgentId: "root",
          parentToolCallId: "delegate-b",
          taskId: "task-b",
        },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-a",
        {
          input: { command: "view", path: "src/a.ts" },
          kind: "tool_called",
          summary: "view src/a.ts",
          title: "Edit",
          toolName: "textEditorTool",
        },
        { parentAgentId: "root", taskId: "task-a", toolCallId: "read-a" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-a",
        {
          kind: "tool_output",
          output: "export const before = true;",
          summary: "finished read",
          title: "Edit",
          toolName: "textEditorTool",
        },
        { parentAgentId: "root", taskId: "task-a", toolCallId: "read-a" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-a",
        {
          input: {
            command: "str_replace",
            new_str: "export const after = true;",
            old_str: "export const before = true;",
            path: "src/a.ts",
          },
          kind: "tool_called",
          summary: "edit src/a.ts",
          title: "Edit",
          toolName: "textEditorTool",
        },
        { parentAgentId: "root", taskId: "task-a", toolCallId: "edit-a" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-a",
        {
          kind: "tool_output",
          output: "updated",
          summary: "finished edit",
          title: "Edit",
          toolName: "textEditorTool",
        },
        { parentAgentId: "root", taskId: "task-a", toolCallId: "edit-a" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-b",
        {
          input: { command: "pnpm test" },
          kind: "tool_called",
          summary: "run tests",
          title: "Bash",
          toolName: "bashTool",
        },
        { parentAgentId: "root", taskId: "task-b", toolCallId: "bash-b" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-b",
        {
          kind: "tool_output",
          output: "2 tests passed",
          summary: "tests passed",
          title: "Bash",
          toolName: "bashTool",
        },
        { parentAgentId: "root", taskId: "task-b", toolCallId: "bash-b" },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-a",
        { kind: "agent_finished", status: "succeeded" },
        {
          occurredAt: "2026-08-10T00:00:05.000Z",
          parentAgentId: "root",
          taskId: "task-a",
        },
      ),
    );
    messageEvents.publish(
      agentEnvelope(
        "child-b",
        { kind: "agent_finished", status: "succeeded" },
        {
          occurredAt: "2026-08-10T00:00:07.000Z",
          parentAgentId: "root",
          taskId: "task-b",
        },
      ),
    );

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Agent(code-reviewer)");
      expect(frame).toContain("Agent(test-runner)");
      expect(frame).toContain("Task: task-a");
      expect(frame).toContain("Task: task-b");
      expect(frame).toContain('Read(file_path: "src/a.ts")');
      expect(frame).toContain('Edit(file_path: "src/a.ts")');
      expect(frame).toContain("Bash(pnpm test)");
      expect(frame).toContain("export const before = true;");
      expect(frame).toContain("- export const before = true;");
      expect(frame).toContain("+ export const after = true;");
      expect(frame).toContain("2 tests passed");
      expect(frame.match(/Succeeded/gu)).toHaveLength(2);
    });

    messageEvents.publish(
      agentEnvelope("child-a", {
        agentName: "code-reviewer",
        kind: "agent_output",
        profileId: "code-reviewer",
        text: "late archived output",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.lastFrame()).not.toContain("late archived output");

    app.unmount();
    expect(messageEvents.listenerCount()).toBe(0);
  });

  it("renders child blocks from the Agent Session submit message callback", async () => {
    const submit = vi.fn(async (_prompt: string, options?: CliAgentSessionSubmitOptions) => {
      options?.onMessage?.(
        agentEnvelope(
          "production-child",
          { agentType: "code", kind: "agent_spawned", profileId: "reviewer" },
          {
            parentAgentId: "root",
            parentToolCallId: "delegate-production",
            taskId: "task-production",
          },
        ),
      );
      options?.onEvent?.({
        agentId: "production-child",
        agentType: "code",
        profileId: "reviewer",
        taskId: "task-production",
        type: "subagent_spawned",
      });
      options?.onMessage?.(
        agentEnvelope(
          "production-child",
          { kind: "assistant_delta", text: "review complete" },
          {
            parentAgentId: "root",
            parentToolCallId: "delegate-production",
            taskId: "task-production",
          },
        ),
      );
      options?.onMessage?.(
        agentEnvelope(
          "production-child",
          { kind: "agent_finished", status: "succeeded" },
          {
            parentAgentId: "root",
            parentToolCallId: "delegate-production",
            taskId: "task-production",
          },
        ),
      );
      return "done";
    });
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit)}
        autoExit={false}
        prompt=""
        staticTranscript={false}
      />,
    );

    app.stdin.write("delegate\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame.match(/Agent\(reviewer\)/gu)).toHaveLength(1);
      expect(frame).toContain("Type: code");
      expect(frame).toContain("Task: task-production");
      expect(frame).toContain("review complete");
      expect(frame).toContain("Succeeded");
    });
    expect(submit).toHaveBeenCalledWith(
      "delegate",
      expect.objectContaining({
        onMessage: expect.any(Function),
      }),
    );
    app.unmount();
  });

  it("renders fallback tool output branches", async () => {
    const circularOutput: Record<string, unknown> = {};
    circularOutput.self = circularOutput;
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });
      options?.onEvent?.({
        input: {
          command: "view",
          path: "empty.ts",
        },
        summary: "view empty.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: undefined,
        summary: "finished empty read",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "view",
          path: "circular.ts",
        },
        summary: "view circular.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: circularOutput,
        summary: "finished circular read",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "insert",
          path: "edit.ts",
        },
        summary: "insert edit.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: undefined,
        summary: "finished edit",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        output: { ok: true },
        summary: "todo fallback",
        title: "TodoWrite",
        toolName: "todoWriteTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        input: {
          command: "view",
        },
        summary: "view",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "1\n2\n3\n4\n5\n6",
        summary: "finished long read",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        summary: "run bash command",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: undefined,
        summary: "finished",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        output: { result: "ok" },
        summary: "object output",
        title: "Tool",
        toolName: "unknownTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        output: "1\n2\n3\n4\n5\n6\n7\n8",
        summary: "long output",
        title: "Tree",
        toolName: "treeTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        output: "not a todo line",
        summary: "invalid todo",
        title: "TodoWrite",
        toolName: "todoWriteTool",
        type: "tool_output",
      });

      return Promise.resolve("done");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("hello\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain('Read(file_path: "empty.ts")');
      expect(frame).toContain("└ (empty output)");
      expect(frame).toContain('Read(file_path: "circular.ts")');
      expect(frame).toContain("└ [object Object]");
      expect(frame).toContain('Edit(file_path: "edit.ts")');
      expect(frame).toContain("└ Edit finished");
      expect(frame).toContain("└ todo fallback");
      expect(frame).toContain('Read(file_path: "unknown")');
      expect(frame).toContain("... (+2 line(s))");
      expect(frame).toContain('Bash(action: "run bash command")');
      expect(frame).toContain("└ Bash finished");
      expect(frame).toContain('{"result":"ok"}');
      expect(frame).toContain("... (+2 line(s))");
      expect(frame).toContain("└ invalid todo");
    });

    app.unmount();
  });

  it("keeps streamed progress when final output differs", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });
      options?.onEvent?.({ text: "Draft progress", type: "message_delta" });

      return Promise.resolve("Final answer");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("hello\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("● Draft progress");
      expect(frame).toContain("● Final answer");
    });

    app.unmount();
  });

  it("renders assistant commentary around tools in chronological segments", async () => {
    const runPromptImpl = vi.fn((_prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onEvent?.({ text: "First, I will inspect.", type: "message_delta" });
      options?.onEvent?.({
        input: {
          command: "pnpm test",
        },
        summary: "run pnpm test",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "tests passed",
        summary: "finished tests",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_output",
      });
      options?.onEvent?.({ text: "Next, I will review the result.", type: "message_delta" });

      return Promise.resolve("First, I will inspect.Next, I will review the result.");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("run\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      const firstIndex = frame.indexOf("First, I will inspect.");
      const toolIndex = frame.indexOf("Bash(pnpm test)");
      const secondIndex = frame.indexOf("Next, I will review the result.");

      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeGreaterThan(firstIndex);
      expect(secondIndex).toBeGreaterThan(toolIndex);
      expect(frame.match(/First, I will inspect\./gu)).toHaveLength(1);
    });

    app.unmount();
  });

  it("auto-submits the startup prompt", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.resolve("agent result");
    });
    const app = render(
      <App autoExit={false} prompt="inspect playground" runPromptImpl={runPromptImpl} />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● agent result");
    });

    expect(runPromptImpl).toHaveBeenCalledWith(
      "inspect playground",
      expect.objectContaining({
        onContext: expect.any(Function),
      }),
    );
    app.unmount();
  });

  it("renders local command help without calling the agent", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("/help\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/clear  Clear messages and queued prompts");
    });

    expect(app.lastFrame()).not.toContain("Compacting context...");
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("runs session status and maintenance slash commands locally", async () => {
    const submit = vi.fn(async () => "not called");
    const compact = vi.fn(async () => undefined);
    const setup = vi.fn(async () => undefined);
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { compact, setup })}
        autoExit={false}
        prompt=""
        sessionId="slash-session"
        workspaceDir="/workspace"
      />,
    );

    app.stdin.write("/status\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Session ID: slash-session");
      expect(app.lastFrame()).toContain("Workspace: /workspace");
    });

    app.stdin.write("/context\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> /context");
      expect(app.lastFrame()).toContain("⎿ Context Usage");
      expect(app.lastFrame()).toContain("◉ System prompt: 0 tokens");
      expect(app.lastFrame()).toContain("○ Context limit unavailable");
    });
    app.stdin.write("/usage\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("No model usage recorded."));
    app.stdin.write("/tasks\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Tasks: 0 completed"));

    app.stdin.write("/compact focus on decisions\r");
    await vi.waitFor(() => {
      expect(compact).toHaveBeenCalledWith("focus on decisions", expect.any(Object));
      expect(app.lastFrame()).toContain("Context compacted.");
    });

    app.stdin.write("/init\r");
    await vi.waitFor(() => expect(setup).toHaveBeenCalledWith("init", expect.any(Object)));
    app.stdin.write("/doctor\r");
    await vi.waitFor(() => expect(setup).toHaveBeenCalledWith("maintenance", expect.any(Object)));

    expect(submit).not.toHaveBeenCalled();
    app.unmount();
  });

  it("opens an interactive command overlay and suspends prompt input", async () => {
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          {
            outputStyle: vi.fn(async () => "default"),
          },
        )}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/output-style\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Select Output Style");
      expect(app.lastFrame()).toContain("default · current");
    });

    app.stdin.write("ignored");
    expect(app.lastFrame()).not.toContain("> ignored");
    app.unmount();
  });

  it("routes Session and runtime workflow commands through the active CLI services", async () => {
    let currentState = cliSessionState("current");
    const switchSession = vi.fn(async (sessionId: string) => {
      currentState = cliSessionState(sessionId, {
        history: {
          entries: [
            { content: "resumed question", role: "user" },
            { content: "resumed answer", role: "assistant" },
          ],
        },
      });
    });
    const renameCurrent = vi.fn(async (title: string) => {
      currentState = { ...currentState, title };
      return currentState;
    });
    const branch = vi.fn(async (title?: string) => {
      currentState = { ...cliSessionState("branch"), ...(title === undefined ? {} : { title }) };
    });
    const rewind = vi.fn(async () => {
      currentState = {
        ...currentState,
        history: { entries: [{ content: "rewound question", role: "user" }] },
      };
    });
    const setModel = vi.fn(async (modelKey: string) => {
      currentState = { ...currentState, modelKey };
    });
    const setOutputStyle = vi.fn(async (outputStyle: SessionState["outputStyle"]) => {
      currentState = { ...currentState, outputStyle };
      return currentState;
    });
    const exportSession = vi.fn(async (filePath?: string) => ({
      filePath: filePath ?? "/exports/current.md",
      messageCount: 3,
    }));
    const agentSession = sessionWithSubmit(
      vi.fn(async () => "unused"),
      {
        branch,
        checkpoints: vi.fn(async () => [
          {
            createdAt: "2026-08-16T00:00:00.000Z",
            historyEntries: [],
            id: "checkpoint-1",
            prompt: "Before rewind",
            sessionRevision: 1,
          },
        ]),
        currentModel: vi.fn(async () => currentState.modelKey),
        exportSession,
        listSessions: vi.fn(async () => [cliSessionState("target")]),
        mcpStatus: vi.fn(async () => []),
        models: vi.fn(async () => [{ key: "next", model: "gpt-next" }]),
        outputStyle: vi.fn(async () => currentState.outputStyle),
        removeSession: vi.fn(async () => undefined),
        renameCurrent,
        rewind,
        setModel,
        setOutputStyle,
        stateSnapshot: vi.fn(async () => currentState),
        switch: switchSession,
      },
    );
    const app = render(<App agentSession={agentSession} autoExit={false} prompt="" />);

    app.stdin.write("/resume target\r");
    await vi.waitFor(() => {
      expect(switchSession).toHaveBeenCalledWith("target");
      expect(app.lastFrame()).toContain("resumed answer");
    });

    app.stdin.write('/rename "New title"\r');
    await vi.waitFor(() => expect(renameCurrent).toHaveBeenCalledWith("New title"));

    app.stdin.write("/branch Alternative\r");
    await vi.waitFor(() => {
      expect(branch).toHaveBeenCalledWith("Alternative");
      expect(app.lastFrame()).toContain("Branched to Session: branch");
    });

    app.stdin.write("/rewind checkpoint-1\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Rewind Session"));
    await new Promise((resolve) => setImmediate(resolve));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Press Enter again to confirm"));
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(rewind).toHaveBeenCalledWith("checkpoint-1");
      expect(app.lastFrame()).toContain("rewound question");
    });

    app.stdin.write("/model next --global\r");
    await vi.waitFor(() => {
      expect(setModel).toHaveBeenCalledWith("next", { global: true });
      expect(app.lastFrame()).toContain("Model: gpt-next");
    });

    app.stdin.write("/output-style compact\r");
    await vi.waitFor(() => expect(setOutputStyle).toHaveBeenCalledWith("compact"));

    app.stdin.write("/export reports/session.md\r");
    await vi.waitFor(() => {
      expect(exportSession).toHaveBeenCalledWith("reports/session.md");
      expect(app.lastFrame()).toContain("Exported 3 messages");
    });
    app.stdin.write("/export\r");
    await vi.waitFor(() => expect(exportSession).toHaveBeenCalledWith(undefined));

    app.stdin.write("/mcp unexpected\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Usage: /mcp"));
    app.unmount();
  });

  it("reports unavailable Session and runtime command capabilities", async () => {
    const app = render(
      <App
        agentSession={sessionWithSubmit(vi.fn(async () => "unused"))}
        autoExit={false}
        prompt=""
      />,
    );

    for (const [command, message] of [
      ["/resume missing", "Session resume is unavailable"],
      ["/rename title", "Session rename is unavailable"],
      ["/branch title", "Session branching is unavailable"],
      ["/rewind checkpoint", "Session rewind is unavailable"],
      ["/model code", "Model switching is unavailable"],
      ["/output-style compact", "Output style changes are unavailable"],
      ["/export", "Session export is unavailable"],
      ["/copy", "No assistant message to copy."],
    ] as const) {
      app.stdin.write(`${command}\r`);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(message));
    }
    app.unmount();
  });

  it("copies committed assistant output through the injected clipboard", async () => {
    const write = vi.fn(async () => undefined);
    const app = render(
      <App
        autoExit={false}
        clipboard={{ write }}
        prompt=""
        runPromptImpl={vi.fn(async () => "assistant output")}
      />,
    );

    app.stdin.write("answer\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("assistant output"));
    app.stdin.write("/copy\r");
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("assistant output"));
    expect(app.lastFrame()).toContain("Copied 16 characters");
    app.unmount();
  });

  it("copies the active streamed assistant while a run is still processing", async () => {
    const write = vi.fn(async () => undefined);
    let finishRun: ((value: string) => void) | undefined;
    const submit = vi.fn(
      async (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finishRun = resolve;
          options?.onEvent?.({ text: "live answer", type: "message_delta" });
        }),
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit)}
        autoExit={false}
        clipboard={{ write }}
        prompt=""
      />,
    );

    app.stdin.write("run\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("live answer"));
    app.stdin.write("/copy\r");
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("live answer"));
    finishRun?.("live answer");
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain("Thinking..."));
    app.unmount();
  });

  it("opens empty runtime and Session pickers through fallback services", async () => {
    for (const [command, title, emptyText] of [
      ["/model", "Select Model", "No models found."],
      ["/mcp", "MCP Servers", "No MCP servers configured"],
      ["/output-style", "Select Output Style", "default · current"],
      ["/resume", "Resume Session", "No Sessions found."],
      ["/rewind", "Rewind Session", "No checkpoints available."],
    ] as const) {
      const app = render(
        <App
          agentSession={sessionWithSubmit(
            vi.fn(async () => "unused"),
            command === "/rewind"
              ? {
                  checkpoints: vi.fn(async () => []),
                  rewind: vi.fn(async () => undefined),
                }
              : {},
          )}
          autoExit={false}
          prompt=""
        />,
      );
      app.stdin.write(`${command}\r`);
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain(title);
        expect(app.lastFrame()).toContain(emptyText);
      });
      app.stdin.write("\u001B");
      await vi.waitFor(() => expect(app.lastFrame()).not.toContain(title));
      app.unmount();
    }
  });

  it("routes the model compatibility fallback", async () => {
    let state = cliSessionState("current");
    const setCurrentModel = vi.fn(async (modelKey: string) => {
      state = { ...state, modelKey };
      return state;
    });
    const setGlobalModel = vi.fn(async () => undefined);
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          {
            currentModel: vi.fn(async () => state.modelKey),
            setCurrentModel,
            setGlobalModel,
            stateSnapshot: vi.fn(async () => state),
          },
        )}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/model next --global\r");
    await vi.waitFor(() => {
      expect(setCurrentModel).toHaveBeenCalledWith("next");
      expect(setGlobalModel).toHaveBeenCalledWith("next");
    });
    app.unmount();
  });

  it("creates an Agent Profile through the reference-style /agent-new wizard", async () => {
    let submittedResponse: UserQuestionResponse | undefined;
    const createAgent: NonNullable<CliAgentSessionContract["createAgent"]> = vi.fn(
      async (_intent, questionHandler) => {
        submittedResponse = await questionHandler({
          description: "我需要先了解你想创建的 subagent 需求。",
          questions: [
            {
              header: "核心用途",
              multiSelect: false,
              options: [
                { description: "审查代码", label: "代码审查" },
                { description: "生成测试", label: "测试生成" },
              ],
              question: "这个 subagent 主要负责什么任务？",
            },
            {
              header: "技术范围",
              multiSelect: true,
              options: [
                { description: "Agent runtime", label: "agent-orchestrator" },
                { description: "文档", label: "文档 docs/" },
              ],
              question: "主要工作在哪个技术栈/区域？",
            },
            {
              header: "主动性",
              multiSelect: false,
              options: [
                { description: "按交流匹配", label: "主动调用" },
                { description: "明确点名", label: "手动调用" },
              ],
              question: "是否希望该 agent 被主动调用？",
            },
          ],
          title: "AskUserQuestion(核心用途，技术范围，主动性)",
        });
        return {
          accessMode: "read-only",
          agentType: "code",
          configPath: "/home/test/.yiku/agents/code-reviewer.md",
          createdAt: "2026-08-08T00:00:00.000Z",
          createdBy: "user",
          deliverable: "A review.",
          description: "Review code.",
          id: "user-agent-1",
          instructions: "Review.",
          invocationMode: "proactive",
          modelKey: "code",
          name: "code-reviewer",
          purpose: "code-review",
          role: "Reviewer.",
          scopes: ["packages/agent-orchestrator"],
          skillSnapshots: [],
          source: "user",
        };
      },
    );
    const runAgent = vi.fn(async () => ({
      agentId: "agent-1",
      finalOutput: "Review complete.",
      profileId: "user-agent-1",
      status: "succeeded" as const,
      taskId: "task-1",
    }));
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          { createAgent, runAgent },
        )}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/agent-new\r");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("● 我需要先了解你想创建的 subagent 需求。");
      expect(frame).toContain("AskUserQuestion(核心用途，技术范围，主动性)");
      expect(frame).toContain("这个 subagent 主要负责什么任务？");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("主要工作在哪个技术栈/区域？"));
    app.stdin.write(" ");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("是否希望该 agent 被主动调用？"));
    app.stdin.write("\r");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Review your answers");
      expect(frame).toContain("核心用途: 代码审查");
      expect(frame).toContain("技术范围: agent-orchestrator");
      expect(frame).toContain("主动性: 主动调用");
    });
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(undefined, expect.any(Function));
      expect(app.lastFrame()).toContain("Config: /home/test/.yiku/agents/code-reviewer.md");
    });
    app.stdin.write("/agent:code-reviewer inspect authentication\r");
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledWith("user-agent-1", "inspect authentication");
      expect(app.lastFrame()).toContain("Review complete.");
    });
    expect(submittedResponse).toEqual({
      answers: [
        {
          answers: ["代码审查"],
          questionIndex: 0,
          selectedIndexes: [0],
        },
        {
          answers: ["agent-orchestrator"],
          questionIndex: 1,
          selectedIndexes: [0],
        },
        {
          answers: ["主动调用"],
          questionIndex: 2,
          selectedIndexes: [0],
        },
      ],
    });
    app.unmount();
  });

  it("shows compact progress until context compaction completes", async () => {
    let finishCompact: (() => void) | undefined;
    const compact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCompact = resolve;
        }),
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          { compact },
        )}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/compact preserve decisions\r");
    await vi.waitFor(() => {
      expect(compact).toHaveBeenCalledWith("preserve decisions", expect.any(Object));
      expect(app.lastFrame()).toContain("Compacting context...");
      expect(app.lastFrame()).not.toContain("Context compacted.");
    });

    finishCompact?.();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Context compacted.");
      expect(app.lastFrame()).not.toContain("Compacting context...");
    });

    app.unmount();
  });

  it("clears compact progress when context compaction fails", async () => {
    let failCompact: ((error: Error) => void) | undefined;
    const compact = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCompact = reject;
        }),
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          { compact },
        )}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/compact\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Compacting context..."));

    failCompact?.(new Error("Compaction failed."));
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Command Error");
      expect(app.lastFrame()).toContain("Compaction failed.");
      expect(app.lastFrame()).not.toContain("Compacting context...");
    });

    app.unmount();
  });

  it("renders inferred model capacity in the context usage command", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({
        ...testContext,
        compactAtContextRatio: 0.92,
        contextWindow: 936_000,
        contextWindowSource: "inferred",
        model: "gpt-5.5",
        prompt,
      });
      options?.onEvent?.({
        model: "gpt-5.5",
        type: "usage_updated",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 25_100,
          outputTokens: 0,
          peakInputTokens: 25_100,
          totalTokens: 25_100,
        },
      });
      return Promise.resolve("ready");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("prime context\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("● ready"));

    app.stdin.write("/context\r");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("gpt-5.5 · 25.1K/936K tokens (2.7%, limit est.)");
      expect(frame).toContain("○ Free space:");
      expect(frame).toContain("⊠ Autocompact buffer:");
      expect(frame).not.toContain("Context limit unavailable");
    });

    app.unmount();
  });

  it("accumulates displayed Context usage until compaction", async () => {
    let runCount = 0;
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      runCount += 1;
      options?.onContext?.({
        ...testContext,
        contextWindow: 10_000,
        model: "gpt-test",
        prompt,
      });
      if (runCount === 3) {
        options?.onEvent?.({
          afterEntries: 1,
          beforeEntries: 10,
          type: "context_compacted",
        });
      }
      const peakInputTokens = [800, 200, 150][runCount - 1] ?? 0;
      options?.onEvent?.({
        model: "gpt-test",
        type: "usage_updated",
        usage: {
          cachedInputTokens: 0,
          inputTokens: peakInputTokens,
          outputTokens: 0,
          peakInputTokens,
          totalTokens: peakInputTokens,
        },
      });
      return Promise.resolve(`done ${runCount}`);
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● done 1");
      expect(app.lastFrame()).toContain("800/10K tokens (8%)");
    });

    app.stdin.write("second\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● done 2");
      expect(app.lastFrame()).toContain("1K/10K tokens (10%)");
    });

    app.stdin.write("third\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● done 3");
      expect(app.lastFrame()).toContain("150/10K tokens (1.5%)");
    });

    app.unmount();
  });

  it("discovers Skill commands and activates them for one run", async () => {
    const submit = vi.fn(async () => "reviewed");
    const skills = vi.fn(async () => [
      {
        description: "Review current changes",
        name: "skill-review",
        path: "/workspace/review.md",
      },
    ]);
    const app = render(
      <App agentSession={sessionWithSubmit(submit, { skills })} autoExit={false} prompt="" />,
    );

    await vi.waitFor(() => expect(skills).toHaveBeenCalled());
    app.stdin.write("/skill-r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/skill-review");
      expect(app.lastFrame()).toContain("Review current changes");
    });
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> /skill-review █");
    });
    app.stdin.write("focus tests\r");

    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith(
        "focus tests",
        expect.objectContaining({
          activatedSkills: ["skill-review"],
          commandArgs: "focus tests",
          commandName: "skill-review",
        }),
      );
      expect(app.lastFrame()).toContain("/skill-review focus tests");
      expect(app.lastFrame()).toContain("reviewed");
    });

    app.unmount();
  });

  it("renders the Skill catalog with source groups and field hierarchy", async () => {
    const skills = vi.fn(async () => [
      {
        description: "Review current changes",
        digest: "abcdef1234567890",
        name: "code-review",
        path: "/builtin/code-review/SKILL.md",
        source: "builtin" as const,
        version: "1.0.0",
      },
      {
        description: "Verify completion evidence",
        digest: "1234567890abcdef",
        name: "near-completion-verifier",
        path: "/workspace/.yiku/skills/near-completion-verifier/SKILL.md",
        source: "project" as const,
        version: "0.0.0-local",
      },
    ]);
    const app = render(
      <App agentSession={sessionWithSubmit(vi.fn(), { skills })} autoExit={false} prompt="" />,
    );
    await vi.waitFor(() => expect(skills).toHaveBeenCalled());
    app.stdin.write("/code-r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("/code-review"));
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain("> /code-r"));
    app.stdin.write("/skills\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Skills (2)");
      expect(frame.indexOf("BUILTIN · 1")).toBeLessThan(frame.indexOf("PROJECT · 1"));
      expect(frame).toContain("├ /code-review · v1.0.0 · abcdef12");
      expect(frame).toContain("└ Review current changes");
      expect(frame).toContain("├ /near-completion-verifier · v0.0.0-local · 12345678");
      expect(frame).not.toContain("skills/code-review");
      expect(frame).not.toContain("skills/near-completion-verifier");
      const lines = frame.split("\n");
      const groupLine = lines.find((line) => line.includes("BUILTIN · 1")) ?? "";
      const metadataLine = lines.find((line) => line.includes("├ /code-review")) ?? "";
      expect(metadataLine.indexOf("├")).toBeGreaterThan(groupLine.indexOf("B"));
    });

    app.unmount();
  });

  it("creates a user Skill and exposes its Slash Command without restarting", async () => {
    const submit = vi.fn(async () => "reviewed");
    let catalog: Array<{
      description: string;
      name: string;
      path: string;
      source: "user";
    }> = [];
    const skills = vi.fn(async () => catalog);
    const createSkill: NonNullable<CliAgentSessionContract["createSkill"]> = vi.fn(
      async (intent, reservedNames) => {
        expect(intent).toBe("给我创建一个代码 review 的技能");
        expect(reservedNames).toContain("skills");
        const skill = {
          description: "Reviews code. Invoke when code changes need review.",
          name: "code-review",
          path: "/home/test/.yiku/skills/code-review/SKILL.md",
          source: "user" as const,
        };
        catalog = [skill];
        return skill;
      },
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { createSkill, skills })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/skills 给我创建一个代码 review 的技能\r");
    await vi.waitFor(() => {
      expect(createSkill).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain("Skill Created");
      expect(app.lastFrame()).toContain(".yiku/skills/code-review/SKILL.md");
    });

    app.stdin.write("/code-review inspect current changes\r");
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith(
        "inspect current changes",
        expect.objectContaining({
          activatedSkills: ["code-review"],
          commandName: "code-review",
        }),
      );
    });

    app.unmount();
  });

  it("installs a user Skill and exposes its Slash Command without restarting", async () => {
    const submit = vi.fn(async () => "audited");
    let catalog: Array<{
      description: string;
      name: string;
      path: string;
      source: "user";
    }> = [];
    const skills = vi.fn(async () => catalog);
    const installSkill: NonNullable<CliAgentSessionContract["installSkill"]> = vi.fn(
      async (source, selector, reservedNames) => {
        expect(source).toBe("acme/agent-skills");
        expect(selector).toBe("dependency-audit");
        expect(reservedNames).toContain("skills");
        const skill = {
          description: "Audit dependencies. Invoke for dependency review.",
          name: "dependency-audit",
          path: "/home/test/.yiku/skills/dependency-audit/SKILL.md",
          source: "user" as const,
        };
        catalog = [skill];
        return skill;
      },
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { installSkill, skills })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("/skills install acme/agent-skills dependency-audit\r");
    await vi.waitFor(() => {
      expect(installSkill).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain("Skill Installed");
      expect(app.lastFrame()).toContain(".yiku/skills/dependency-audit/SKILL.md");
    });

    app.stdin.write("/dependency-audit inspect manifests\r");
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith(
        "inspect manifests",
        expect.objectContaining({
          activatedSkills: ["dependency-audit"],
          commandName: "dependency-audit",
        }),
      );
    });

    app.unmount();
  });

  it("falls back to the created Skill and reports unavailable creation", async () => {
    const submit = vi.fn(async () => "done");
    const createSkill: NonNullable<CliAgentSessionContract["createSkill"]> = vi.fn(async () => ({
      description: "Reviews code. Invoke for code review.",
      name: "created-review",
      path: "/home/test/.yiku/skills/review/SKILL.md",
      source: "user",
    }));
    const app = render(
      <App agentSession={sessionWithSubmit(submit, { createSkill })} autoExit={false} prompt="" />,
    );

    app.stdin.write("/skills create review\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Skill Created"));
    app.stdin.write("/created-review inspect\r");
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "inspect",
        expect.objectContaining({ activatedSkills: ["created-review"] }),
      ),
    );
    app.unmount();

    const unavailable = render(
      <App
        agentSession={sessionWithSubmit(vi.fn(async () => "unused"))}
        autoExit={false}
        prompt=""
      />,
    );
    unavailable.stdin.write("/skills create review\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Skill creation is unavailable"),
    );
    unavailable.stdin.write("/skills install acme/skills review\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Skill installation is unavailable"),
    );
    unavailable.stdin.write("/compact\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Context compaction is unavailable"),
    );
    unavailable.stdin.write("/agent-new reviewer\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Agent creation is unavailable"),
    );
    unavailable.stdin.write("/agents list\r");
    await vi.waitFor(() => expect(unavailable.lastFrame()).toContain("No Agent Profiles"));
    unavailable.stdin.write("/agents remove missing\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Agent removal is unavailable"),
    );
    unavailable.stdin.write("/agents show missing\r");
    await vi.waitFor(() =>
      expect(unavailable.lastFrame()).toContain("Agent inspection is unavailable"),
    );
    unavailable.unmount();
  });

  it("queues idle slash commands behind an active run", async () => {
    let resolveRun: ((output: string) => void) | undefined;
    const submit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const compact = vi.fn(async () => undefined);
    const app = render(
      <App agentSession={sessionWithSubmit(submit, { compact })} autoExit={false} prompt="" />,
    );

    app.stdin.write("slow task\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Thinking..."));
    app.stdin.write("/compact preserve decisions\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("› /compact preserve decisions"));
    expect(compact).not.toHaveBeenCalled();

    resolveRun?.("done");
    await vi.waitFor(() => {
      expect(compact).toHaveBeenCalledWith("preserve decisions", expect.any(Object));
      expect(app.lastFrame()).toContain("Context compacted.");
    });
    expect(submit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("cancels an active task with escape and ignores its eventual result", async () => {
    let resolvePrompt: ((output: string) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });
      capturedSignal = options?.signal;

      return new Promise<string>((resolve) => {
        resolvePrompt = resolve;
      });
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("slow task\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Canceled current task.");
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toMatchObject({
      message: "User canceled the active task with Escape.",
    });

    resolvePrompt?.("late result");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.lastFrame()).not.toContain("late result");
    app.unmount();
  });

  it("aborts an active model request with ctrl+c without exiting", async () => {
    const onExitCode = vi.fn();
    let capturedSignal: AbortSignal | undefined;
    const runPromptImpl = vi.fn((_prompt: string, options?: ExecuteAgentSessionOptions) => {
      capturedSignal = options?.signal;

      return new Promise<string>(() => undefined);
    });
    const app = render(
      <App autoExit={false} onExitCode={onExitCode} prompt="" runPromptImpl={runPromptImpl} />,
    );

    app.stdin.write("slow task\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("\u0003");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Canceled current task.");
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(onExitCode).not.toHaveBeenCalled();

    app.unmount();
  });

  it("prompts before a risky Bash command and rejects it by default", async () => {
    const decisions: string[] = [];
    const runPromptImpl = vi.fn(async (_prompt: string, options?: ExecuteAgentSessionOptions) => {
      const response = await options?.permissionApprovalHandler?.({
        action: "execute command",
        capabilities: ["process.execute", "workspace.delete"],
        metadata: {
          commandTruncated: "true",
        },
        normalizedAction: "recursively remove workspace files",
        policyId: "recursive-force-rm",
        reason: "recursively force-removes files or directories",
        risk: "high",
        subject: "rm -rf ./build",
        toolName: "bashTool",
        workspaceId: "workspace-1",
      });
      decisions.push(response?.decision ?? "missing");

      return response?.decision ?? "missing";
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("clean build\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("Shell 命令需要授权");
      expect(frame).toContain("本次需求：clean build");
      expect(frame).toContain("操作目的：recursively remove workspace files");
      expect(frame).toContain("命令：rm -rf ./build [已截断]");
      expect(frame).toContain("风险原因：recursively force-removes files or directories");
      expect(frame).toContain("● 拒绝执行");
    });

    await new Promise((resolve) => setImmediate(resolve));
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(decisions).toEqual(["deny"]);
    });

    app.unmount();
  });

  it("upgrades a read-only Workspace and persists the grant when selected", async () => {
    const persistWorkspaceWriteAccess = vi.fn(async () => undefined);
    const decisions: string[] = [];
    const runPromptImpl = vi.fn(async (_prompt: string, options?: ExecuteAgentSessionOptions) => {
      const response = await options?.workspaceAccessApprovalHandler?.({
        action: "edit",
        subject: "src/index.ts",
        workspaceId: "workspace-1",
      });
      decisions.push(
        response?.decision === "allow" ? `${response.decision}:${response.persistence}` : "deny",
      );
      return "edited";
    });
    const app = render(
      <App
        accessMode="read-only"
        autoExit={false}
        persistWorkspaceWriteAccess={persistWorkspaceWriteAccess}
        prompt=""
        runPromptImpl={runPromptImpl}
      />,
    );

    app.stdin.write("edit file\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("编辑需要工作区写权限");
    });
    await new Promise((resolve) => setImmediate(resolve));
    app.stdin.write("\u001B[B");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(decisions).toEqual(["allow:persistent"]);
      expect(persistWorkspaceWriteAccess).toHaveBeenCalledOnce();
    });
    app.unmount();
  });

  it("allows a risky Bash command after explicit selection", async () => {
    const decisions: string[] = [];
    const runPromptImpl = vi.fn(async (_prompt: string, options?: ExecuteAgentSessionOptions) => {
      const response = await options?.permissionApprovalHandler?.({
        action: "execute command",
        capabilities: ["process.execute", "workspace.write", "git.history"],
        normalizedAction: "discard local git changes",
        policyId: "git-reset-hard",
        reason: "discards local git changes",
        risk: "high",
        subject: "git reset --hard",
        toolName: "bashTool",
        workspaceId: "workspace-1",
      });
      decisions.push(response?.decision ?? "missing");

      return response?.decision ?? "missing";
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("reset\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● 拒绝执行");
    });

    await new Promise((resolve) => setImmediate(resolve));
    app.stdin.write("\u001B[A");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● 长期允许此策略");
    });

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(decisions).toEqual(["allow"]);
    });

    app.unmount();
  });

  it("rejects a pending Bash approval when ctrl+c cancels the task", async () => {
    const decisions: string[] = [];
    const runPromptImpl = vi.fn(async (_prompt: string, options?: ExecuteAgentSessionOptions) => {
      const response = await options?.permissionApprovalHandler?.({
        action: "execute command",
        capabilities: ["process.execute", "workspace.delete"],
        normalizedAction: "delete matching workspace files",
        policyId: "find-delete",
        reason: "deletes files",
        risk: "high",
        subject: "find . -name '*.log' -delete",
        toolName: "bashTool",
        workspaceId: "workspace-1",
      });
      decisions.push(response?.decision ?? "missing");

      return "finished";
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("delete logs\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Shell 命令需要授权");
    });

    app.stdin.write("\u0003");

    await vi.waitFor(() => {
      expect(decisions).toEqual(["deny"]);
      expect(app.lastFrame()).toContain("Canceled current task.");
    });

    app.unmount();
  });

  it("collects a selected option and continues the active Agent run", async () => {
    const answers: string[] = [];
    let finish: ((output: string) => void) | undefined;
    const submit = vi.fn(
      (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          options?.onEvent?.({
            questionId: "question-1",
            request: {
              options: ["PostgreSQL", "SQLite"],
              question: "Which database should we use?",
            },
            type: "user_question_requested",
          });
        }),
    );
    const answerUserQuestion = vi.fn(
      (_questionId: string, response: { readonly answer: string }) => {
        answers.push(response.answer);
        finish?.(`selected ${response.answer}`);
      },
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { answerUserQuestion })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("design storage\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Which database should we use?");
      expect(app.lastFrame()).toContain("› 1. PostgreSQL");
      expect(app.lastFrame()).toContain("2. SQLite");
    });

    app.stdin.write("\u001B[B");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(answers).toEqual(["SQLite"]);
      expect(answerUserQuestion).toHaveBeenCalledWith("question-1", {
        answer: "SQLite",
        selectedIndex: 1,
      });
      expect(app.lastFrame()).toContain("selected SQLite");
    });
    expect(submit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("collects a free-text answer through the active Runtime question", async () => {
    let finish: ((output: string) => void) | undefined;
    const submit = vi.fn(
      (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          options?.onEvent?.({
            questionId: "question-text",
            request: {
              question: "Which migration strategy should we use?",
            },
            type: "user_question_requested",
          });
        }),
    );
    const answerUserQuestion = vi.fn(
      (_questionId: string, response: { readonly answer: string }) => {
        finish?.(`strategy ${response.answer}`);
      },
    );
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { answerUserQuestion })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("plan migration\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Which migration strategy should we use?");
    });
    app.stdin.write("expand-contract");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(answerUserQuestion).toHaveBeenCalledWith("question-text", {
        answer: "expand-contract",
      });
      expect(app.lastFrame()).toContain("strategy expand-contract");
    });
    app.unmount();
  });

  it("cancels the active Run when a Runtime question is canceled", async () => {
    let finish: ((output: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const submit = vi.fn(
      (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          signal = options?.signal;
          options?.onEvent?.({
            questionId: "question-cancel",
            request: {
              question: "Provide optional details.",
            },
            type: "user_question_requested",
          });
        }),
    );
    const cancelUserQuestion = vi.fn((_questionId: string, reason?: string) => {
      finish?.(`continued after ${reason ?? "cancel"}`);
    });
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { cancelUserQuestion })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("continue task\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Provide optional details.");
    });
    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(cancelUserQuestion).toHaveBeenCalledWith(
        "question-cancel",
        "User canceled the interaction.",
      );
      expect(signal?.aborted).toBe(true);
      expect(app.lastFrame()).toContain("Canceled current task.");
      expect(app.lastFrame()).not.toContain("continued after User canceled the interaction.");
    });
    expect(submit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("answers concurrent Runtime questions in FIFO order", async () => {
    let finish: ((output: string) => void) | undefined;
    const answered: string[] = [];
    const submit = vi.fn(
      (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          options?.onEvent?.({
            questionId: "question-first",
            request: {
              options: ["First A", "First B"],
              question: "First question?",
            },
            type: "user_question_requested",
          });
          options?.onEvent?.({
            questionId: "question-second",
            request: {
              options: ["Second A", "Second B"],
              question: "Second question?",
            },
            type: "user_question_requested",
          });
        }),
    );
    const answerUserQuestion = vi.fn((questionId: string) => {
      answered.push(questionId);
      if (answered.length === 2) {
        finish?.(answered.join(","));
      }
    });
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { answerUserQuestion })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("ask twice\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("First question?");
      expect(app.lastFrame()).not.toContain("Second question?");
    });
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Second question?");
    });
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(answered).toEqual(["question-first", "question-second"]);
      expect(app.lastFrame()).toContain("question-first,question-second");
    });
    app.unmount();
  });

  it("answers a structured multi-question form and continues the same run", async () => {
    let finish: ((output: string) => void) | undefined;
    const submit = vi.fn(
      (_prompt: string, options?: CliAgentSessionSubmitOptions) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          options?.onEvent?.({
            questionId: "question-form",
            request: {
              questions: [
                {
                  header: "数据库",
                  multiSelect: false,
                  options: [
                    { description: "生产数据库", label: "PostgreSQL" },
                    { description: "本地数据库", label: "SQLite" },
                  ],
                  question: "选择数据库。",
                },
                {
                  header: "检查项",
                  multiSelect: true,
                  options: [
                    { description: "运行测试", label: "测试" },
                    { description: "运行静态检查", label: "Lint" },
                  ],
                  question: "选择检查项。",
                },
              ],
            },
            type: "user_question_requested",
          });
        }),
    );
    const answerUserQuestion = vi.fn((_questionId: string, response: UserQuestionResponse) => {
      finish?.(JSON.stringify(response));
    });
    const app = render(
      <App
        agentSession={sessionWithSubmit(submit, { answerUserQuestion })}
        autoExit={false}
        prompt=""
      />,
    );

    app.stdin.write("configure\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("选择数据库。");
      expect(app.lastFrame()).toContain("□ 数据库");
      expect(app.lastFrame()).toContain("□ 检查项");
      expect(app.lastFrame()).toContain("✓ Submit");
    });
    app.stdin.write("\u001B[B");
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("选择检查项。");
      expect(app.lastFrame()).toContain("[ ] 测试");
    });
    app.stdin.write(" ");
    app.stdin.write("\u001B[B");
    app.stdin.write(" ");
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Review your answers");
      expect(app.lastFrame()).toContain("数据库: SQLite");
      expect(app.lastFrame()).toContain("检查项: 测试, Lint");
    });
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(answerUserQuestion).toHaveBeenCalledWith("question-form", {
        answers: [
          {
            answers: ["SQLite"],
            questionIndex: 0,
            selectedIndexes: [1],
          },
          {
            answers: ["测试", "Lint"],
            questionIndex: 1,
            selectedIndexes: [0, 1],
          },
        ],
      });
      expect(app.lastFrame()).toContain('"answers":["SQLite"]');
    });
    expect(submit).toHaveBeenCalledOnce();
    app.unmount();
  });

  it("exits on a second ctrl+c within one second while a task is running", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn(() => new Promise<string>(() => undefined));
    const app = render(
      <App autoExit={false} onExitCode={onExitCode} prompt="" runPromptImpl={runPromptImpl} />,
    );

    app.stdin.write("slow task\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("\u0003");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Ctrl+C again to exit");
      expect(app.lastFrame()).toContain("Canceled current task.");
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain("Ctrl+C again to exit");
      expect(app.lastFrame()).toContain("/ command mode");
    });

    app.stdin.write("\u0003");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Ctrl+C again to exit");
    });

    app.stdin.write("\u0003");

    await vi.waitFor(() => {
      const output = app.frames.join("\n");

      expect(onExitCode).toHaveBeenCalledWith(0);
      expect(output).toContain("Session ID:");
      expect(output).toContain("Tool calls:");
    });

    app.unmount();
  });

  it("ignores an active task failure after cancel", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    let emitEvent: ExecuteAgentSessionOptions["onEvent"];
    const runPromptImpl = vi.fn(
      (_prompt: string, options?: ExecuteAgentSessionOptions) =>
        new Promise<string>((_, reject) => {
          options?.onContext?.({
            ...testContext,
            contextWindow: 10_000,
          });
          emitEvent = options?.onEvent;
          rejectPrompt = reject;
        }),
    );
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("slow failure\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Canceled current task.");
    });

    emitEvent?.({
      model: "gpt-playground",
      type: "usage_updated",
      usage: {
        cachedInputTokens: 0,
        inputTokens: 5_000,
        outputTokens: 0,
        peakInputTokens: 5_000,
        totalTokens: 5_000,
      },
    });
    rejectPrompt?.(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.lastFrame()).not.toContain("late failure");
    expect(app.lastFrame()).toContain("0/10K tokens (0%)");
    expect(app.lastFrame()).not.toContain("5K/10K tokens");
    app.unmount();
  });

  it("renders agent failures and stays in the session", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });
      options?.onEvent?.({
        durationMs: 25,
        error: "provider quota exceeded",
        finishedAt: "2026-08-13T00:00:00.000Z",
        sessionId: "session-1",
        type: "session_failed",
      });

      return Promise.reject(new Error("agent failed"));
    });
    const app = render(
      <App autoExit={false} onExitCode={onExitCode} prompt="" runPromptImpl={runPromptImpl} />,
    );

    app.stdin.write("fail\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Error: agent failed");
      expect(app.lastFrame()).toContain("Error: provider quota exceeded");
      expect(app.lastFrame()).toContain("Session: session-1");
    });

    expect(onExitCode).toHaveBeenCalledWith(1);
    app.unmount();
  });

  it("finds a project source through an Error cause chain", async () => {
    const cause = new Error("inner failure");
    cause.stack = [
      "Error: inner failure",
      "    at execute (/workspace/playground/example.ts:42:7)",
    ].join("\n");
    const error = new Error("outer failure", { cause });
    error.stack = [
      "Error: outer failure",
      "    at dependency (/workspace/node_modules/example/index.js:1:1)",
    ].join("\n");
    const runPromptImpl = vi.fn(async () => Promise.reject(error));
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("fail with cause\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Error: outer failure");
      expect(app.lastFrame()).toContain("playground/example.ts:42:7");
    });

    app.unmount();
  });

  it("renders empty agent output and no-instructions context", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({
        ...testContext,
        hasInstructions: false,
        prompt,
      });

      return Promise.resolve("");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("empty output\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("● (empty output)");
      expect(frame).toContain("@ file search");
    });

    app.unmount();
  });

  it("renders non-error failures", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.reject("string failure");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("fail string\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Error: string failure");
    });

    app.unmount();
  });

  it("supports input editing", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("abc");
    app.stdin.write("\u007F");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> ab█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("clears draft input with ctrl+u and escape and ignores plain tab", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("draft");
    app.stdin.write("\t");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> draft█");
    });

    app.stdin.write("\u0015");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> Ask anything...");
    });

    app.stdin.write("draft");
    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> Ask anything...");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("ignores empty submits and clears idle input with escape", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("\r");
    app.stdin.write("draft");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> draft█");
    });

    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> Ask anything...");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("supports left and right cursor movement while editing input", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("ac");
    app.stdin.write("\u001B[D");
    app.stdin.write("b");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("> abc");
    });

    app.stdin.write("\u001B[C");
    app.stdin.write("d");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> abcd█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("moves vertically across input lines before navigating history", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("abcd\nx\nwxyz");
    app.stdin.write("\u001B[A");
    app.stdin.write("\u001B[A");
    app.stdin.write("!");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("> abcd!");
      expect(frame).toContain("  x");
      expect(frame).toContain("  wxyz");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("supports option word movement and home/end line movement", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("alpha beta");
    app.stdin.write("\u001Bb");
    app.stdin.write("X");
    app.stdin.write("\u001B[1;3C");
    app.stdin.write("!");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> alpha Xbeta!█");
    });

    app.stdin.write("\u0015");
    app.stdin.write("first\nsecond");
    app.stdin.write("\u001B[H");
    app.stdin.write("X");
    app.stdin.write("\u001B[F");
    app.stdin.write("Y");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("> first");
      expect(frame).toContain("  XsecondY█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("supports delete and ignores empty-history navigation", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("\u001B[A");
    app.stdin.write("\u001B[B");
    app.stdin.write("\u007F");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> Ask anything...");
    });

    app.stdin.write("abc");
    app.stdin.write("\u001B[D");
    app.stdin.write("\u001B[3~");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("> ab");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("restores submitted command history with up and down arrows", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.resolve(`agent result for ${prompt}`);
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("agent result for first");
    });

    app.stdin.write("second\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("agent result for second");
    });

    app.stdin.write("\u001B[A");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> second█");
    });

    app.stdin.write("\u001B[A");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> second");
    });

    app.stdin.write("\u001B[A");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> first█");
    });

    app.stdin.write("\u001B[B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> second█");
    });

    app.stdin.write("\u001B[B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> Ask anything...");
    });

    expect(runPromptImpl).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("keeps input editable while processing and queues submitted messages", async () => {
    let resolvePrompt: ((output: string) => void) | undefined;
    const outputs = ["first result", "second result"];
    const runPromptImpl = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePrompt = () => resolve(outputs.shift() ?? "agent result");
        }),
    );
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("second");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> second█");
    });

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("› second");
      expect(app.lastFrame()).toContain("Press up to edit queued messages");
    });

    resolvePrompt?.("first result");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● first result");
    });

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledTimes(2);
    });

    resolvePrompt?.("second result");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● second result");
      expect(app.lastFrame()).toContain("Thought for");
    });

    expect(runPromptImpl).toHaveBeenNthCalledWith(
      1,
      "first",
      expect.objectContaining({
        onContext: expect.any(Function),
      }),
    );
    expect(runPromptImpl).toHaveBeenNthCalledWith(
      2,
      "second",
      expect.objectContaining({
        onContext: expect.any(Function),
      }),
    );
    app.unmount();
  });

  it("edits the last queued message with up while processing", async () => {
    const runPromptImpl = vi.fn(
      () =>
        new Promise<string>(() => {
          // Keep running so queued messages stay visible.
        }),
    );
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("queued\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("› queued");
    });

    app.stdin.write("\u001B[A");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> queued█");
      expect(app.lastFrame()).not.toContain("› queued");
    });

    app.unmount();
  });

  it("shows slash command suggestions and handles unknown slash commands", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("/");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/clear (reset)");
      expect(app.lastFrame()).toContain("Clear messages and queued prompts");
      expect(app.lastFrame()).toContain("/help");
      expect(app.lastFrame()).toContain("Show available slash commands");
    });

    app.stdin.write("missing\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Unknown command: /missing");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("updates the thinking indicator while a task is running", async () => {
    const runPromptImpl = vi.fn((_prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onEvent?.({ type: "reasoning" });
      options?.onEvent?.({ text: "hello", type: "message_delta" });
      options?.onEvent?.({
        summary: "list .",
        title: "Ls",
        toolName: "lsTool",
        type: "tool_called",
      });

      return new Promise<string>(() => {
        // Keep the task pending so the interval-driven thinking state can tick.
      });
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("slow task\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("Thinking...");
      expect(frame.lastIndexOf("Thinking...")).toBeGreaterThan(frame.lastIndexOf('Ls(path: ".")'));
      expect(frame.match(/Thinking\.\.\./gu)).toHaveLength(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(app.lastFrame()).toContain("Thinking...");
    app.unmount();
  });

  it("clears messages with /clear", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("/help\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/clear  Clear messages and queued prompts");
    });

    app.stdin.write("/clear\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("Welcome back");
      expect(frame).not.toContain("/clear  Clear messages and queued prompts");
      expect(frame).not.toContain("Messages cleared.");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("exits with local command and clears a draft before ctrl+c exits", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn(async () => "not called");
    const commandApp = render(
      <App
        autoExit={false}
        onExitCode={onExitCode}
        prompt=""
        runPromptImpl={runPromptImpl}
        sessionId="command-session"
      />,
    );

    commandApp.stdin.write("/exit\r");

    await vi.waitFor(() => {
      const output = commandApp.frames.join("\n");

      expect(onExitCode).toHaveBeenCalledWith(0);
      expect(output).toContain("Session ID: command-session");
      expect(output).toContain("    none");
    });

    commandApp.unmount();
    onExitCode.mockClear();

    const ctrlCApp = render(
      <App
        autoExit={false}
        onExitCode={onExitCode}
        prompt=""
        runPromptImpl={runPromptImpl}
        sessionId="ctrl-c-session"
      />,
    );

    ctrlCApp.stdin.write("draft");
    ctrlCApp.stdin.write("\u0003");

    await vi.waitFor(() => {
      expect(ctrlCApp.lastFrame()).toContain("> Ask anything...");
      expect(ctrlCApp.lastFrame()).toContain("Ctrl+C again to exit");
    });
    expect(onExitCode).not.toHaveBeenCalled();

    ctrlCApp.stdin.write("\u0003");

    await vi.waitFor(() => {
      const output = ctrlCApp.frames.join("\n");

      expect(onExitCode).toHaveBeenCalledWith(0);
      expect(output).toContain("Session ID: ctrl-c-session");
    });

    ctrlCApp.unmount();
  });

  it("aggregates context, usage, tools, and code changes before manual exit", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({
        ...testContext,
        contextWindow: 936_000,
        model: "openrouter-3o",
        prompt,
        sessionId: options.sessionId ?? "missing",
      });
      options?.onEvent?.({
        input: {
          command: "str_replace",
          new_str: "new\nvalue",
          old_str: "old",
          path: "sample.ts",
        },
        summary: "replace sample.ts",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      });
      options?.onEvent?.({
        output: "replaced",
        summary: "finished edit",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_output",
      });
      options?.onEvent?.({
        model: "openrouter-3o",
        type: "usage_updated",
        usage: {
          cachedInputTokens: 723_800,
          inputTokens: 868_400,
          outputTokens: 4_100,
          peakInputTokens: 77_800,
          totalTokens: 872_500,
        },
      });

      return Promise.resolve("done");
    });
    const app = render(
      <App
        autoExit={false}
        onExitCode={onExitCode}
        prompt=""
        runPromptImpl={runPromptImpl}
        sessionId="metrics-session"
      />,
    );

    app.stdin.write("update\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● done");
      expect(app.lastFrame()).toContain("Model: openrouter-3o");
      expect(app.lastFrame()).toContain("Context: ██░░░░░░░░░░░░░░░░░░ 77.8K/936K tokens (8.3%)");
    });

    app.stdin.write("/exit\r");

    await vi.waitFor(() => {
      const output = app.frames.join("\n");

      expect(onExitCode).toHaveBeenCalledWith(0);
      expect(output).toContain("Session ID: metrics-session");
      expect(output).toContain("Model: openrouter-3o");
      expect(output).toContain("Context Window: 8.3% used (77.8K / 936K)");
      expect(output).toContain("Total code changes: 2 lines added, 1 lines removed");
      expect(output).toContain("    openrouter-3o: 868.4K input, 4.1K output, 723.8K cache read");
      expect(output).toContain("    Edit: 1 call, 0 errors, 0s");
    });
    expect(runPromptImpl).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({
        sessionId: "metrics-session",
      }),
    );

    app.unmount();
  });

  it("reuses one Session ID across multiple prompts", async () => {
    const runPromptImpl = vi.fn(
      async (_prompt: string, _options?: ExecuteAgentSessionOptions) => "done",
    );
    const app = render(
      <App autoExit={false} prompt="" runPromptImpl={runPromptImpl} sessionId="shared-session" />,
    );

    app.stdin.write("first\r");
    await vi.waitFor(() => expect(runPromptImpl).toHaveBeenCalledTimes(1));
    app.stdin.write("second\r");
    await vi.waitFor(() => expect(runPromptImpl).toHaveBeenCalledTimes(2));

    expect(runPromptImpl.mock.calls.map((call) => call[1]?.sessionId)).toEqual([
      "shared-session",
      "shared-session",
    ]);

    app.unmount();
  });

  it("truncates long draft input", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);
    const longInput = "x".repeat(140);

    app.stdin.write(longInput);

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("...");
    });

    expect(app.lastFrame()).not.toContain(longInput);
    app.unmount();
  });

  it("truncates long draft input around a cursor inside the text", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);
    const longInput = "x".repeat(140);

    app.stdin.write(longInput);
    app.stdin.write("\u001B[D");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("...");
    });

    expect(app.lastFrame()).not.toContain(longInput);
    app.unmount();
  });

  it("auto exits on startup prompt failure when autoExit is enabled", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.reject(new Error("agent failed"));
    });
    const app = render(
      <App
        autoExit={true}
        onExitCode={onExitCode}
        prompt="inspect playground"
        runPromptImpl={runPromptImpl}
      />,
    );

    await vi.waitFor(() => {
      expect(onExitCode).toHaveBeenCalledWith(1);
    });
    expect(app.lastFrame()).not.toContain("Usage by model:");

    app.unmount();
  });

  it("exits after the startup prompt when autoExit is enabled", async () => {
    const onExitCode = vi.fn();
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.resolve("agent result");
    });
    const app = render(
      <App
        autoExit={true}
        onExitCode={onExitCode}
        prompt="inspect playground"
        runPromptImpl={runPromptImpl}
      />,
    );

    await vi.waitFor(() => {
      expect(onExitCode).toHaveBeenCalledWith(0);
    });
    expect(app.lastFrame()).not.toContain("Usage by model:");

    app.unmount();
  });

  it("inserts a newline with ctrl+j and keeps earlier lines visible", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first");
    app.stdin.write("\n");
    app.stdin.write("second");

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("> first");
      expect(frame).toContain("second█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("inserts a newline with shift+enter and submits the complete prompt with enter", async () => {
    const runPromptImpl = vi.fn(async () => "agent result");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first");
    app.stdin.write("\u001B[13;2u");
    app.stdin.write("second");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("> first");
      expect(frame).toContain("  second█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "first\nsecond",
        expect.objectContaining({ onContext: expect.any(Function) }),
      );
    });

    app.unmount();
  });

  it("continues a line with a trailing backslash and enter, then submits with enter", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.resolve("agent result");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("first\\");
    app.stdin.write("\r");
    app.stdin.write("second");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("> first");
      expect(frame).toContain("  second█");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "first\nsecond",
        expect.objectContaining({ onContext: expect.any(Function) }),
      );
    });

    app.unmount();
  });

  it("commits one static header after the real model resolves on startup", async () => {
    const app = render(
      <App
        agentSession={sessionWithSubmit(
          vi.fn(async () => "unused"),
          {
            currentModel: vi.fn(async () => "code"),
            models: vi.fn(async () => [
              { key: "code", model: "openrouter-3o", provider: "openrouter" },
            ]),
          },
        )}
        autoExit={false}
        prompt=""
        staticTranscript
      />,
    );

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Model: openrouter-3o");
    });
    expect(app.lastFrame()).not.toContain("Model: model resolving");
    expect(app.lastFrame()?.match(/Welcome back/gu)).toHaveLength(1);
    expect(app.stdout.frames.filter((frame) => frame === "\u001B[2J\u001B[H")).toHaveLength(0);
    app.stdin.write("/clear\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Model: openrouter-3o");
      expect(app.lastFrame()).not.toContain("Model: model resolving");
      expect(app.lastFrame()?.match(/Welcome back/gu)).toHaveLength(1);
      expect(app.stdout.frames.filter((frame) => frame === "\u001B[2J\u001B[H")).toHaveLength(1);
    });

    app.unmount();
  });

  it("runs a ! shell command and renders its output without calling the agent", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const run = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "file-a\nfile-b\n",
      timedOut: false,
      truncated: false,
    }));
    const app = render(
      <App autoExit={false} prompt="" runPromptImpl={runPromptImpl} shellCommandRunner={{ run }} />,
    );

    app.stdin.write("!ls\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("> !ls");
      expect(frame).toContain("file-a");
      expect(frame).toContain("file-b");
      expect(frame).toContain("Thought for");
    });

    expect(run).toHaveBeenCalledWith(
      "ls",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("reports a non-zero shell exit code as an error result", async () => {
    const run = vi.fn(async () => ({
      exitCode: 2,
      stderr: "boom\n",
      stdout: "",
      timedOut: false,
      truncated: false,
    }));
    const app = render(
      <App
        autoExit={false}
        prompt=""
        runPromptImpl={vi.fn(async () => "not called")}
        shellCommandRunner={{ run }}
      />,
    );

    app.stdin.write("!bad-command\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";

      expect(frame).toContain("Shell (exit 2)");
      expect(frame).toContain("boom");
    });

    app.unmount();
  });

  it("cancels an in-flight ! shell command with escape", async () => {
    let capturedSignal: AbortSignal | undefined;
    const run = vi.fn(
      (_command: string, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          capturedSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason ?? new Error("aborted"));
          });
        }),
    );
    const app = render(
      <App
        autoExit={false}
        prompt=""
        runPromptImpl={vi.fn(async () => "not called")}
        shellCommandRunner={{ run }}
      />,
    );

    app.stdin.write("!sleep 5\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Thinking...");
    });

    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Canceled current task.");
    });
    expect(capturedSignal?.aborted).toBe(true);

    app.unmount();
  });

  it("recalls a separate ! shell history distinct from prompt history", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
      timedOut: false,
      truncated: false,
    }));
    const runPromptImpl = vi.fn(async () => "agent result");
    const app = render(
      <App autoExit={false} prompt="" runPromptImpl={runPromptImpl} shellCommandRunner={{ run }} />,
    );

    app.stdin.write("plain prompt\r");
    await vi.waitFor(() => expect(runPromptImpl).toHaveBeenCalledTimes(1));

    app.stdin.write("!git status\r");
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith("git status", expect.any(Object)));

    // Typing ! then Up recalls only prior shell commands, not the plain prompt.
    app.stdin.write("!");
    app.stdin.write("\u001B[A");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("> !git status");
      expect(frame).not.toContain("> !plain prompt");
    });

    // Clearing to an empty prompt and pressing Up recalls the plain prompt history.
    app.stdin.write("\u0015");
    app.stdin.write("\u001B[A");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> plain prompt");
    });

    app.unmount();
  });

  it("submits multi-line input with enter", async () => {
    const runPromptImpl = vi.fn((prompt: string, options?: ExecuteAgentSessionOptions) => {
      options?.onContext?.({ ...testContext, prompt });

      return Promise.resolve("agent result");
    });
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("line one");
    app.stdin.write("\n");
    app.stdin.write("line two");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "line one\nline two",
        expect.objectContaining({ onContext: expect.any(Function) }),
      );
    });

    app.unmount();
  });

  it("preserves and submits a 10k character input", async () => {
    const longInput = "x".repeat(10_000);
    const runPromptImpl = vi.fn(async () => "agent result");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write(longInput);
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        longInput,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    app.unmount();
  });

  it("inserts a multi-line pasted chunk without submitting or truncating it", async () => {
    const pastedInput = "first pasted line\nsecond pasted line\nthird pasted line";
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write(pastedInput);

    await vi.waitFor(() => {
      const frame = app.lastFrame();

      expect(frame).toContain("first pasted line");
      expect(frame).toContain("second pasted line");
      expect(frame).toContain("third pasted line█");
    });
    expect(runPromptImpl).not.toHaveBeenCalled();

    app.unmount();
  });

  it("completes an @ file query and inserts the selected entry", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const readDirectory = createReadDirectory();
    const app = render(
      <App
        autoExit={false}
        prompt=""
        readDirectory={readDirectory}
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace"
      />,
    );

    app.stdin.write("@pack");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("packages/");
    });

    app.stdin.write("\t");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("@packages/");
    });

    expect(readDirectory).toHaveBeenCalled();
    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("moves the file completion selection with arrow keys", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const readDirectory = createReadDirectory();
    const app = render(
      <App
        autoExit={false}
        prompt=""
        readDirectory={readDirectory}
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace"
      />,
    );

    app.stdin.write("@");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("README.md");
    });

    app.stdin.write("\u001B[B");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("@playground/");
    });

    app.unmount();
  });

  it("dismisses the file completion menu with escape", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const readDirectory = createReadDirectory();
    const app = render(
      <App
        autoExit={false}
        prompt=""
        readDirectory={readDirectory}
        runPromptImpl={runPromptImpl}
        workspaceDir="/workspace"
      />,
    );

    app.stdin.write("@pack");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("packages/");
    });

    app.stdin.write("\u001B");

    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain("▸ packages/");
    });

    app.unmount();
  });

  it("selects a slash command with arrows, fills it, then runs it with enter", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("/");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/help");
      expect(app.lastFrame()).toContain("Context: unavailable");
      expect(app.lastFrame()).toContain("GENERAL");
      expect(app.lastFrame()).not.toContain("more commands");
      expect(app.lastFrame()).not.toContain("/ command mode");
    });

    app.stdin.write("\u001B[B");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> /help █");
      expect(app.lastFrame()).toContain("/ command mode");
    });
    expect(runPromptImpl).not.toHaveBeenCalled();

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Show available slash commands");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("completes a slash token inside text and submits the complete prompt", async () => {
    const runPromptImpl = vi.fn(async () => "done");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("请执行 /he");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/help");
    });

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> 请执行 /help █");
    });
    expect(runPromptImpl).not.toHaveBeenCalled();

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(runPromptImpl).toHaveBeenCalledWith(
        "请执行 /help",
        expect.objectContaining({
          onEvent: expect.any(Function),
        }),
      );
    });

    app.unmount();
  });

  it("tab-completes the selected slash command into the input", async () => {
    const runPromptImpl = vi.fn(async () => "not called");
    const app = render(<App autoExit={false} prompt="" runPromptImpl={runPromptImpl} />);

    app.stdin.write("/cl");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("/clear");
    });

    app.stdin.write("\t");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("> /clear █");
    });

    expect(runPromptImpl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("uses a dedicated Hook trust prompt and closes the persistent session", async () => {
    const close = vi.fn(async () => undefined);
    const submit = vi.fn(async (_prompt: string, options?: CliAgentSessionSubmitOptions) => {
      const response = await options?.hookTrustApprovalHandler?.(hookTrustRequest());
      return response === undefined
        ? "missing"
        : `${response.decision}:${response.scope ?? "none"}`;
    });
    const agentSession: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close,
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit,
    };
    const app = render(<App agentSession={agentSession} autoExit={false} prompt="" />);

    app.stdin.write("run hook\r");

    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Yiku Hook 需要信任");
      expect(frame).toContain("触发：UserPromptSubmit");
      expect(frame).toContain("command:/bin/sh:echo ok");
      expect(frame).toContain("Hash：abcdef012345");
    });

    app.stdin.write("\u001B[D");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● 仅本次信任并执行");
    });

    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● allow:once");
    });

    app.unmount();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it("reviews an uncertain resumed side effect before continuing", async () => {
    const submit = vi.fn(async (_prompt: string, options?: CliAgentSessionSubmitOptions) => {
      const response = await options?.resumeReviewHandler?.({
        operation: {
          callId: "call-1",
          effect: "external",
          inputSummary: "create issue",
          stageId: "stage-1",
          startedAt: "2026-08-01T00:00:00.000Z",
          toolName: "mcp__github__create_issue",
        },
      });
      return response?.action ?? "missing";
    });
    const agentSession: CliAgentSessionContract = {
      answerUserQuestion: vi.fn(),
      cancelUserQuestion: vi.fn(),
      clear: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      hooks: vi.fn(async () => undefined),
      pendingUserQuestions: () => [],
      setup: vi.fn(async () => undefined),
      submit,
    };
    const app = render(<App agentSession={agentSession} autoExit={false} prompt="" />);

    app.stdin.write("continue\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("检测到结果未知的副作用");
      expect(app.lastFrame()).toContain("mcp__github__create_issue");
    });
    app.stdin.write("\u001B[A");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● 确认未执行并重试");
    });
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("● retry");
    });
    app.unmount();
  });

  it("collects and submits MCP form Elicitation JSON", async () => {
    const submit = vi.fn(async (_prompt: string, options?: CliAgentSessionSubmitOptions) => {
      const response = await options?.mcpElicitationHandler?.({
        message: "Choose policy mode",
        mode: "form",
        requestId: "request-1",
        requestedSchema: {
          properties: {
            mode: { type: "string" },
          },
          required: ["mode"],
          type: "object",
        },
        server: "policy",
      });
      return JSON.stringify(response);
    });
    const agentSession = sessionWithSubmit(submit);
    const app = render(<App agentSession={agentSession} autoExit={false} prompt="" />);

    app.stdin.write("configure\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("MCP 请求用户输入");
      expect(app.lastFrame()).toContain("Choose policy mode");
    });
    app.stdin.write("\u007F");
    await vi.waitFor(() => {
      expect(
        app
          .lastFrame()
          ?.split("\n")
          .find((line) => line.includes("响应：")),
      ).not.toContain("{}");
    });
    app.stdin.write("\u007F");
    await vi.waitFor(() => {
      const line = app
        .lastFrame()
        ?.split("\n")
        .find((candidate) => candidate.includes("响应："));
      expect(line).not.toContain("{");
      expect(line).not.toContain("}");
    });
    app.stdin.write('{"mode":"strict"}');
    app.stdin.write("\u001B[D");
    app.stdin.write("\r");

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('"action":"accept"');
      expect(app.lastFrame()).toContain('"mode":"strict"');
    });
    app.unmount();
  });

  it("validates, edits, declines, and accepts MCP Elicitation modes", async () => {
    let request = 0;
    const submit = vi.fn(async (_prompt: string, options?: CliAgentSessionSubmitOptions) => {
      request += 1;
      if (request === 1) {
        return JSON.stringify(
          await options?.mcpElicitationHandler?.({
            message: "Invalid first",
            requestId: "request-1",
            server: "policy",
          }),
        );
      }
      if (request === 2) {
        return JSON.stringify(
          await options?.mcpElicitationHandler?.({
            message: "Decline this",
            requestId: "request-2",
            server: "policy",
          }),
        );
      }
      return JSON.stringify(
        await options?.mcpElicitationHandler?.({
          message: "Authorize URL",
          mode: "url",
          requestId: "request-3",
          server: "policy",
          url: "https://example.test/authorize",
        }),
      );
    });
    const app = render(<App agentSession={sessionWithSubmit(submit)} autoExit={false} prompt="" />);

    app.stdin.write("invalid\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Invalid first"));
    app.stdin.write("\u007F");
    await vi.waitFor(() => {
      expect(
        app
          .lastFrame()
          ?.split("\n")
          .find((line) => line.includes("响应：")),
      ).not.toContain("{}");
    });
    app.stdin.write("\u007F");
    await vi.waitFor(() => {
      const line = app
        .lastFrame()
        ?.split("\n")
        .find((candidate) => candidate.includes("响应："));
      expect(line).not.toContain("{");
      expect(line).not.toContain("}");
    });
    app.stdin.write("[");
    app.stdin.write("\u001B[D");
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("请输入有效的 JSON 对象");
    });
    app.stdin.write("\u007F");
    await vi.waitFor(() => {
      expect(
        app
          .lastFrame()
          ?.split("\n")
          .find((line) => line.includes("响应：")),
      ).not.toContain("[");
    });
    app.stdin.write("{}");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain('"action":"accept"'));

    app.stdin.write("decline\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Decline this"));
    app.stdin.write("\u001B");
    await vi.waitFor(() => expect(app.lastFrame()).toContain('"action":"decline"'));

    app.stdin.write("url\r");
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("https://example.test/authorize");
    });
    app.stdin.write("\u001B[A");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain('"action":"accept"'));
    app.unmount();
  });
});

function cliSessionState(sessionId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...createInitialSessionState({
      agentKey: "code",
      configFingerprint: "config",
      modelKey: "model",
      now: "2026-08-10T00:00:00.000Z",
      sessionId,
      workspaceDir: "/workspace",
    }),
    ...overrides,
  };
}

function sessionWithSubmit(
  submit: CliAgentSessionContract["submit"],
  overrides: Partial<CliAgentSessionContract> = {},
): CliAgentSessionContract {
  return {
    answerUserQuestion: vi.fn(),
    cancelUserQuestion: vi.fn(),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    hooks: vi.fn(async () => undefined),
    pendingUserQuestions: () => [],
    setup: vi.fn(async () => undefined),
    submit,
    ...overrides,
  };
}

function testAgentMessageSource() {
  const listeners = new Set<(message: AgentMessageEnvelope) => void>();

  return {
    listenerCount: () => listeners.size,
    publish: (message: AgentMessageEnvelope) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
    source: {
      subscribe(listener: (message: AgentMessageEnvelope) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

interface AgentEnvelopeOptions {
  readonly occurredAt?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly parentToolCallId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly toolCallId?: string | undefined;
}

let agentEnvelopeSequence = 0;

function agentEnvelope<TPayload extends AgentMessagePayload>(
  agentId: string,
  payload: TPayload,
  options: AgentEnvelopeOptions = {},
): AgentMessageEnvelope<TPayload> {
  agentEnvelopeSequence += 1;

  return {
    agentId,
    eventId: `app-event-${agentEnvelopeSequence}`,
    occurredAt: options.occurredAt ?? "2026-08-10T00:00:02.000Z",
    ...(options.parentAgentId !== undefined ? { parentAgentId: options.parentAgentId } : {}),
    ...(options.parentToolCallId !== undefined
      ? { parentToolCallId: options.parentToolCallId }
      : {}),
    payload,
    sessionId: "test-session",
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
  };
}

function hookTrustRequest(): HookTrustRequest {
  return {
    capability: "command:/bin/sh:echo ok",
    eventName: "UserPromptSubmit",
    executorType: "command",
    handlerHash: "abcdef0123456789",
    hookId: "hook_test",
    opaque: true,
    source: {
      path: "/workspace/config.yaml",
      priority: 30,
      type: "project",
    },
    trustKey: "trust_test",
  };
}
