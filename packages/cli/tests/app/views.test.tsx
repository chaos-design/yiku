import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  ContextUsageView,
  Header,
  MessageView,
  SessionSummaryView,
  SlashCommandMenu,
  StatusBar,
  Timeline,
} from "../../src/app/views.js";

describe("Header", () => {
  it("renders the right-side session metadata", () => {
    const app = render(
      <Header
        context={{
          model: "gpt-test",
          workspaceDir: "/workspace/app",
        }}
        modelFallback="fallback-model"
        userName="tester"
        workspaceFallback="/fallback"
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Welcome back, tester");
    expect(frame).toContain("Model: gpt-test");
    expect(frame).toContain("Workspace: /workspace/app");
    expect(frame).not.toContain("Yiku Session");

    app.rerender(
      <Header modelFallback="fallback-model" userName="" workspaceFallback="/fallback" />,
    );
    expect(app.lastFrame()).toContain("Welcome back, user");
    expect(app.lastFrame()).toContain("Model: fallback-model");
    expect(app.lastFrame()).toContain("Workspace: /fallback");

    app.unmount();
  });
});

describe("MessageView", () => {
  it("keeps command result hierarchy in line-level Ink containers", () => {
    const app = render(
      <MessageView
        message={{
          id: 1,
          lineColors: ["cyan", "green", "gray"],
          lineIndents: [0, 1, 1],
          role: "command",
          text: [
            "BUILTIN · 1",
            "├ /code-review · v1.0.0",
            "└ Review code changes for defects and regressions.",
          ].join("\n"),
          title: "Skills (1)",
        }}
      />,
    );
    const lines = (app.lastFrame() ?? "").split("\n");
    const groupLine = lines.find((line) => line.includes("BUILTIN")) ?? "";
    const commandLine = lines.find((line) => line.includes("├ /code-review")) ?? "";
    const descriptionLine = lines.find((line) => line.includes("└ Review code changes")) ?? "";

    expect(commandLine.indexOf("├")).toBeGreaterThan(groupLine.indexOf("B"));
    expect(descriptionLine.indexOf("└")).toBe(commandLine.indexOf("├"));
    expect(app.lastFrame()).not.toContain("skills/code-review");
    app.unmount();
  });

  it("keeps wrapped tree descriptions aligned after their branch marker", () => {
    const app = render(
      <MessageView
        message={{
          id: 1,
          lineColors: ["gray"],
          lineIndents: [2],
          role: "command",
          text: [
            "└ Create, revise, and validate Agent Skills. Invoke whenever users request a new Skill,",
            "changes to an existing Skill, or better Skill triggering and instructions.",
          ].join(" "),
          title: "Skills (1)",
        }}
      />,
    );
    const lines = (app.lastFrame() ?? "").split("\n");
    const descriptionLine = lines.find((line) => line.includes("└ Create")) ?? "";
    const continuationLine = lines.find((line) => line.includes("to an existing")) ?? "";

    expect(continuationLine.indexOf("to")).toBe(descriptionLine.indexOf("Create"));
    app.unmount();
  });
});

describe("SlashCommandMenu", () => {
  it("renders uppercase command groups with one AGENTS and SKILLS category", () => {
    const app = render(
      <SlashCommandMenu
        commands={[
          {
            description: "Show help",
            execute: () => ({ kind: "success" }),
            kind: "local",
            name: "help",
            source: "builtin",
          },
          {
            description: "Review authentication",
            execute: () => ({ kind: "success" }),
            kind: "local",
            name: "agent:security-reviewer",
            source: "agent",
          },
          {
            description: "List Skills",
            execute: () => ({ kind: "success" }),
            kind: "local",
            name: "skills",
            source: "builtin",
          },
          {
            description: "Review code",
            getSubmission: () => ({
              activatedSkills: ["code-review"],
              commandName: "code-review",
              displayPrompt: "/code-review",
              kind: "submit",
              prompt: "Run review",
            }),
            kind: "prompt",
            name: "code-review",
            source: "skill",
          },
        ]}
        selectedIndex={1}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("GENERAL (1)");
    expect(frame).toContain("AGENTS (1)");
    expect(frame).toContain("SKILLS (2)");
    expect(frame.match(/SKILLS \(2\)/gu)).toHaveLength(1);
    expect(frame).toContain("/agent:security-reviewer");
    expect(frame).toContain("/code-review");
    expect(frame).not.toContain("agents/security-reviewer");
    expect(frame).not.toContain("skills/code-review");
    app.unmount();
  });

  it("scrolls a compact bounded command window", () => {
    const commands = Array.from({ length: 14 }, (_, index) => ({
      description: `Command ${index}`,
      execute: () => ({ kind: "success" as const }),
      kind: "local" as const,
      name: `command-${index}`,
      source: "builtin" as const,
    }));
    const app = render(
      <SlashCommandMenu commands={commands} maxVisibleRows={7} selectedIndex={0} />,
    );
    const firstFrame = app.lastFrame() ?? "";
    const firstLines = firstFrame.split("\n");
    const firstCommandLine = firstLines.findIndex((line) => line.includes("/command-0"));

    expect(firstFrame).toContain("GENERAL (14)");
    expect(firstFrame).toContain("/command-0");
    expect(firstFrame).not.toContain("/command-13");
    expect(firstLines[firstCommandLine + 1]).toContain("/command-1");

    app.rerender(<SlashCommandMenu commands={commands} maxVisibleRows={7} selectedIndex={13} />);
    expect(app.lastFrame()).toContain("GENERAL (14)");
    expect(app.lastFrame()).toContain("/command-13");
    expect(app.lastFrame()).not.toContain("/command-0");
    app.unmount();
  });

  it("limits Skill hints to two visible rows", () => {
    const app = render(
      <SlashCommandMenu
        commands={[
          {
            description:
              "This intentionally long Skill description must remain visible for two rows while additional navigation details, invocation guidance, operational constraints, and the final hidden marker stay hidden.",
            getSubmission: () => ({
              activatedSkills: ["long-skill"],
              commandName: "long-skill",
              displayPrompt: "/long-skill",
              kind: "submit" as const,
              prompt: "Run Skill",
            }),
            kind: "prompt" as const,
            name: "long-skill",
            source: "skill" as const,
          },
        ]}
        maxVisibleRows={6}
        selectedIndex={0}
        terminalColumns={64}
      />,
    );
    const frame = app.lastFrame() ?? "";
    const lines = frame.split("\n");
    const descriptionLineIndex = lines.findIndex((line) => line.includes("This intentionally"));
    const descriptionLine = lines[descriptionLineIndex] ?? "";
    const continuationLine = lines[descriptionLineIndex + 1] ?? "";

    expect(lines).toHaveLength(3);
    expect(frame).not.toContain("stay hidden.");
    expect(continuationLine.search(/\S/u)).toBe(descriptionLine.indexOf("This"));
    app.unmount();
  });
});

describe("StatusBar", () => {
  it("renders shortcuts, model, and Context on separate rows", () => {
    const app = render(
      <StatusBar contextTokens={25_100} contextWindow={936_000} model="gpt-5.3" />,
    );
    const lines = (app.lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("/ command mode");
    expect(lines[1]).toContain("Model: gpt-5.3");
    expect(lines[2]).toContain("Context: █░░░░░░░░░░░░░░░░░░░ 25.1K/936K tokens (2.7%)");

    app.rerender(<StatusBar contextTokens={468_000} contextWindow={936_000} model="gpt-5.3" />);
    expect(app.lastFrame()).toContain("Context: ██████████░░░░░░░░░░ 468K/936K tokens (50%)");

    app.rerender(<StatusBar contextTokens={0} message="Hook pending" model="gpt-5.3" />);
    expect(app.lastFrame()).toContain("Hook pending");
    expect(app.lastFrame()).toContain("Context: unavailable");

    app.rerender(<StatusBar contextTokens={0} model="gpt-5.3" showShortcuts={false} />);
    expect(app.lastFrame()).not.toContain("/ command mode");
    expect(app.lastFrame()).toContain("Model: gpt-5.3");
    expect(app.lastFrame()).toContain("Context: unavailable");

    app.unmount();
  });
});

describe("ContextUsageView", () => {
  it("renders calibrated categories and a 100-cell Context grid", () => {
    const app = render(
      <ContextUsageView
        title="Context Usage"
        usage={{
          autocompactBufferTokens: 100,
          categories: [
            { key: "system-prompt", label: "System prompt", tokens: 100 },
            { key: "working-memory", label: "Working memory", tokens: 20 },
            { key: "messages", label: "Messages", tokens: 80 },
          ],
          contextWindow: 1_000,
          contextWindowSource: "inferred",
          freeTokens: 700,
          model: "gpt-5.5",
          usedTokens: 200,
        }}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("gpt-5.5 · 200/1K tokens (20%, limit est.)");
    expect(frame).toContain("◉ Working memory: 20 tokens (2%)");
    expect(frame).toContain("⊠ Autocompact buffer: 100 tokens (10%)");
    expect(frame.match(/[◉○⊠]/gu)).toHaveLength(105);
    app.unmount();
  });
});

describe("Timeline", () => {
  it("renders the first project source for runtime errors", () => {
    const app = render(
      <Timeline
        generation={0}
        items={[]}
        nowMs={0}
        spinnerIndex={0}
        staticTranscript={false}
        status={{
          kind: "error",
          message: "Cannot read properties of undefined",
          source: "at run (/workspace/packages/example.ts:42:7)",
        }}
      />,
    );

    expect(app.lastFrame()).toContain("! Error: Cannot read properties of undefined");
    expect(app.lastFrame()).toContain("packages/example.ts:42:7");
    app.unmount();
  });

  it("renders committed messages, tools, and run summaries", () => {
    const app = render(
      <Timeline
        generation={0}
        items={[
          {
            id: "message:1",
            kind: "message",
            message: {
              id: 1,
              role: "user",
              text: "show `tree` output",
            },
          },
          {
            id: "message:2",
            kind: "message",
            message: {
              id: 2,
              role: "system",
              text: "Using `find` as a fallback.",
            },
          },
          {
            id: "message:command",
            kind: "message",
            message: {
              id: 3,
              role: "command",
              text: "● Used: 20 tokens\n○ Free space: 80 tokens",
              title: "Context Usage",
            },
          },
          {
            call: {
              text: "Bash(cd pwd)",
            },
            id: "tool:3",
            kind: "tool",
            result: {
              details: ["line 2"],
              text: "line 1",
            },
            toolName: "bashTool",
          },
          {
            id: "message:4",
            kind: "message",
            message: {
              id: 4,
              role: "assistant",
              text: "`pnpm` workspace is under packages/.",
            },
          },
          {
            content: {
              details: ["Reason: max_turns"],
              text: "Stage stage-1 continued",
            },
            id: "runtime:5",
            kind: "runtime",
          },
          {
            durationSeconds: 33,
            id: "summary:6",
            kind: "summary",
          },
        ]}
        nowMs={0}
        spinnerIndex={0}
        staticTranscript={false}
        status={{ kind: "idle" }}
      />,
    );

    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("> show tree output");
    expect(frame).toContain("● Using find as a fallback.");
    expect(frame).toContain("⎿ Context Usage");
    expect(frame).toContain("● Used: 20 tokens");
    expect(frame).toContain("● Bash(cd pwd)");
    expect(frame).toContain("└ line 1");
    expect(frame).toContain("line 2");
    expect(frame).toContain("● pnpm workspace is under packages/.");
    expect(frame).toContain("● Stage stage-1 continued");
    expect(frame).toContain("Reason: max_turns");
    expect(frame).toContain("Thought for 33s");
    expect(
      frame
        .split("\n")
        .find((line) => line.includes("Thought for 33s"))
        ?.indexOf("Thought for 33s"),
    ).toBe(84);
    expect(frame).not.toContain("`tree`");

    app.unmount();
  });

  it("renders committed history before live assistant, tool, and thinking", () => {
    const app = render(
      <Timeline
        activeAssistant={{
          id: 2,
          role: "assistant",
          text: "live commentary",
        }}
        activeTool={{
          call: {
            text: "Bash(pnpm test)",
          },
          id: "tool:3",
          kind: "tool",
          toolName: "bashTool",
        }}
        generation={0}
        items={[
          {
            id: "message:1",
            kind: "message",
            message: {
              id: 1,
              role: "assistant",
              text: "committed commentary",
            },
          },
        ]}
        nowMs={2_000}
        spinnerIndex={0}
        staticTranscript
        status={{
          kind: "processing",
          prompt: "test",
          responseBytes: 4,
          startedAtMs: 0,
        }}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("committed commentary");
    expect(frame).toContain("live commentary");
    expect(frame).toContain("Bash(pnpm test)");
    expect(frame).toContain("Thinking...");
    expect(frame).toContain("Thinking... (2s)");
    expect(frame.lastIndexOf("Thinking...")).toBeGreaterThan(frame.lastIndexOf("Bash(pnpm test)"));

    app.rerender(
      <Timeline
        generation={0}
        items={[]}
        nowMs={1}
        spinnerIndex={1}
        staticTranscript={false}
        status={{
          kind: "processing",
          prompt: "test",
          responseBytes: 12 * 1024,
          startedAtMs: 0,
        }}
      />,
    );
    expect(app.lastFrame()).toContain("Thinking... (0s)");

    app.unmount();
  });

  it("renders parallel nested subagent tools and completed duration", () => {
    const app = render(
      <Timeline
        agents={[
          {
            agentId: "child-a",
            agentName: "Reviewer",
            agentSessionId: "session.agent.child-a",
            agentType: "code",
            completedAt: "2026-08-10T00:01:05.000Z",
            items: [
              {
                call: { text: 'Read(file_path: "src/a.ts")' },
                id: "tool:read-a",
                kind: "tool",
                result: { text: "export const a = true;" },
                toolName: "textEditorTool",
              },
              {
                call: { text: 'Edit(file_path: "src/a.ts")' },
                id: "tool:edit-a",
                kind: "tool",
                result: { text: "1 addition(s) and 1 deletion(s)" },
                toolName: "textEditorTool",
              },
            ],
            prompt: "inspect files",
            startedAt: "2026-08-10T00:00:00.000Z",
            status: "succeeded",
          },
          {
            activeTool: {
              call: { text: "Bash(pnpm test)" },
              id: "tool:bash-b",
              kind: "tool",
              toolName: "bashTool",
            },
            agentId: "child-b",
            agentName: "Researcher",
            agentSessionId: "session.agent.child-b",
            agentType: "research",
            items: [],
            status: "running",
            taskId: "task-b",
          },
        ]}
        generation={0}
        items={[]}
        nowMs={0}
        spinnerIndex={0}
        staticTranscript={false}
        status={{ kind: "idle" }}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Agent(Reviewer)");
    expect(frame).toContain("Type: code · Session:");
    expect(frame).toContain("Task: inspect files");
    expect(frame).toContain("├ ● Read");
    expect(frame).toContain("├ ● Edit");
    expect(frame).toContain("Succeeded in 1m5s");
    expect(frame).toContain("Agent(Researcher)");
    expect(frame).toContain("Type: research · Session:");
    expect(frame).toContain("Task: task-b");
    expect(frame).toContain("└ ● Bash(pnpm test)");

    app.unmount();
  });

  it("renders failed and cancelled Subagents with optional timeline item variants", () => {
    const summary = {
      addedLines: 0,
      apiDurationMs: 0,
      checkpointCount: 0,
      model: "model",
      peakInputTokens: 0,
      removedLines: 0,
      sessionId: "session",
      stageCount: 0,
      tasks: { blocked: 0, completed: 0, inProgress: 0, pending: 0 },
      toolCalls: [],
      usageByModel: [],
      wallDurationMs: 0,
    };
    const app = render(
      <Timeline
        agents={[
          {
            activeAssistant: {
              id: 1,
              role: "assistant",
              text: "active child response",
            },
            agentId: "failed",
            completedAt: "invalid",
            error: "provider disconnected",
            items: [
              {
                content: { text: "child runtime event" },
                id: "runtime",
                kind: "runtime",
              },
              { durationSeconds: 3, id: "summary", kind: "summary" },
              {
                id: "header",
                kind: "header",
                model: "model",
                workspaceDir: "/workspace",
              },
              { id: "session-summary", kind: "session-summary", summary },
            ],
            startedAt: "also-invalid",
            status: "failed",
          },
          {
            agentId: "cancelled",
            completedAt: "2026-08-10T00:00:00.000Z",
            items: [],
            prompt: "cancelled task",
            status: "cancelled",
          },
        ]}
        generation={0}
        items={[]}
        nowMs={0}
        spinnerIndex={0}
        staticTranscript={false}
        status={{ kind: "idle" }}
      />,
    );

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Agent(subagent)");
    expect(frame).toContain("Type: unknown");
    expect(frame).toContain("child runtime event");
    expect(frame).toContain("Thought for 3s");
    expect(frame).toContain("active child response");
    expect(frame).toContain("Failed");
    expect(frame).toContain("Reason: provider disconnected");
    expect(frame).not.toContain("Failed in");
    expect(frame).toContain("Task: cancelled task");
    expect(frame).toContain("Cancelled");
    app.unmount();
  });

  it("applies compact, default, and verbose tool density", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const tool = {
      call: { text: 'Read(file_path: "src/index.ts")' },
      id: "tool:read",
      kind: "tool" as const,
      output,
      result: {
        details: ["line 2", "line 3", "line 4", "... (+16 line(s))"],
        text: "line 1",
      },
      toolName: "readTool",
    };
    const base = {
      generation: 0,
      items: [tool],
      nowMs: 0,
      spinnerIndex: 0,
      staticTranscript: false,
      status: { kind: "idle" as const },
    };
    const app = render(<Timeline {...base} outputStyle="compact" />);

    expect(app.lastFrame()).toContain('Read(file_path: "src/index.ts") → 20 lines');
    expect(app.lastFrame()).not.toContain("line 2");

    app.rerender(<Timeline {...base} outputStyle="default" />);
    expect(app.lastFrame()).toContain("... (+16 line(s))");
    expect(app.lastFrame()).not.toContain("line 20");

    app.rerender(<Timeline {...base} outputStyle="verbose" />);
    expect(app.lastFrame()).toContain("line 20");

    app.rerender(
      <Timeline
        {...base}
        agents={[
          {
            agentId: "child",
            agentName: "Reviewer",
            agentSessionId: "session.agent.child",
            agentType: "code",
            items: [tool],
            status: "succeeded",
            taskId: "task",
          },
        ]}
        items={[]}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("Agent(Reviewer)");
    expect(app.lastFrame()).toContain("Task: task");
    expect(app.lastFrame()).not.toContain("line 20");
    app.unmount();
  });
});

describe("SessionSummaryView", () => {
  it("renders the reference field order and compact metrics", () => {
    const app = render(
      <SessionSummaryView
        summary={{
          addedLines: 12,
          apiDurationMs: 115_000,
          checkpointCount: 9,
          contextWindow: 936_000,
          model: "openrouter-3o",
          pauseReason: "needs-review",
          peakInputTokens: 77_800,
          removedLines: 3,
          sessionId: "94f2ab63",
          stageCount: 2,
          tasks: {
            blocked: 1,
            completed: 3,
            inProgress: 0,
            pending: 1,
          },
          toolCalls: [
            {
              calls: 8,
              durationMs: 33_000,
              errors: 0,
              name: "Bash",
            },
            {
              calls: 1,
              durationMs: 7_000,
              errors: 1,
              name: "Read",
            },
          ],
          usageByModel: [
            {
              cachedInputTokens: 723_800,
              inputTokens: 868_400,
              model: "openrouter-3o",
              outputTokens: 4_100,
            },
          ],
          wallDurationMs: 5_220_000,
        }}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Session ID: 94f2ab63");
    expect(frame).toContain("Model: openrouter-3o");
    expect(frame).toContain("Context Window: 8.3% used (77.8K / 936K)");
    expect(frame).toContain("Long-running: 2 stages, 9 checkpoints");
    expect(frame).toContain("Tasks: 3 completed, 0 in progress, 1 pending, 1 blocked");
    expect(frame).toContain("Paused: needs-review");
    expect(frame).toContain("Total duration (API): 1m55s");
    expect(frame).toContain("Total duration (wall): 1h27m");
    expect(frame).toContain("Total code changes: 12 lines added, 3 lines removed");
    expect(frame).toContain("    openrouter-3o: 868.4K input, 4.1K output, 723.8K cache read");
    expect(frame).toContain("    Bash: 8 calls, 0 errors, 33s");
    expect(frame).toContain("    Read: 1 call, 1 error, 7s");
    expect(frame.indexOf("Session ID:")).toBeLessThan(frame.indexOf("Session\n"));
    expect(frame.indexOf("Usage by model:")).toBeLessThan(frame.indexOf("Tool calls:"));

    app.unmount();
  });

  it("renders empty usage and tool sections", () => {
    const app = render(
      <SessionSummaryView
        summary={{
          addedLines: 0,
          apiDurationMs: 0,
          checkpointCount: 0,
          model: "model",
          peakInputTokens: 0,
          removedLines: 0,
          sessionId: "session",
          stageCount: 0,
          tasks: {
            blocked: 0,
            completed: 0,
            inProgress: 0,
            pending: 0,
          },
          toolCalls: [],
          usageByModel: [],
          wallDurationMs: 0,
        }}
      />,
    );

    expect(app.lastFrame()?.match(/ {4}none/gu)).toHaveLength(2);
    expect(app.lastFrame()).toContain("Context Window: 0 used (limit unknown)");

    app.unmount();
  });
});
