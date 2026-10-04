import { describe, expect, it } from "vitest";
import {
  formatRuntimeEvent,
  formatToolCall,
  formatToolResult,
} from "../../src/app/tool-presentation.js";

describe("tool presentation", () => {
  it("formats an AskUser call", () => {
    expect(
      formatToolCall({
        input: {
          question: "Which database should we use?",
        },
        summary: "ask Which database should we use?",
        title: "AskUser",
        toolName: "AskUserQuestion",
        type: "tool_called",
      }),
    ).toEqual({
      text: 'AskUser(question: "Which database should we use?")',
    });

    expect(
      formatToolCall({
        input: {
          questions: [
            {
              header: "标题风格",
              multiSelect: false,
              options: [],
              question: "选择标题风格。",
            },
            {
              header: "检查项",
              multiSelect: true,
              options: [],
              question: "选择检查项。",
            },
          ],
        },
        summary: "ask 选择标题风格。",
        title: "AskUser",
        toolName: "AskUserQuestion",
        type: "tool_called",
      }),
    ).toEqual({
      text: 'AskUser(header: "标题风格", question: "选择标题风格。", questions: 2)',
    });

    expect(
      formatToolCall({
        summary: "ask user",
        title: "AskUser",
        toolName: "AskUserQuestion",
        type: "tool_called",
      }),
    ).toEqual({
      text: 'AskUser(question: "unknown")',
    });
  });

  it("formats Bash call and result", () => {
    expect(
      formatToolCall({
        input: {
          command: "pnpm test",
        },
        summary: "run pnpm test",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      }),
    ).toEqual({
      text: "Bash(pnpm test)",
    });
    expect(
      formatToolCall({
        input: {
          restart: true,
        },
        summary: "restart bash session",
        title: "Bash",
        toolName: "bashTool",
        type: "tool_called",
      }),
    ).toEqual({
      text: "Bash(restart: true)",
    });
    expect(
      formatToolResult(
        {
          output: "line 1\nline 2",
          summary: "finished",
          title: "Bash",
          toolName: "bashTool",
          type: "tool_output",
        },
        {
          command: "pnpm test",
        },
      ),
    ).toEqual({
      details: ["line 2"],
      text: "line 1",
    });
    expect(
      formatToolResult(
        {
          output: "1\n2\n3\n4\n5",
          summary: "finished",
          title: "Bash",
          toolName: "bashTool",
          type: "tool_output",
        },
        {
          command: "printf output",
        },
      ),
    ).toEqual({
      details: ["2", "3", "... (+2 line(s))"],
      text: "1",
    });
  });

  it("formats Grep, Ls, and Tree calls with optional arguments", () => {
    expect(
      formatToolCall({
        input: {
          case_sensitive: false,
          include_hidden: true,
          max_results: 50,
          path: "packages",
          pattern: "CodeAgent",
        },
        summary: "search",
        title: "Grep",
        toolName: "grepTool",
        type: "tool_called",
      }).text,
    ).toBe(
      'Grep(pattern: "CodeAgent", path: "packages", case_sensitive: false, include_hidden: true, max_results: 50)',
    );
    expect(
      formatToolCall({
        input: {},
        summary: "list",
        title: "Ls",
        toolName: "lsTool",
        type: "tool_called",
      }).text,
    ).toBe('Ls(path: ".")');
    expect(
      formatToolCall({
        input: {
          max_depth: 3,
          max_entries: 100,
          path: ".",
        },
        summary: "tree",
        title: "Tree",
        toolName: "treeTool",
        type: "tool_called",
      }).text,
    ).toBe('Tree(path: ".", max_depth: 3, max_entries: 100)');
  });

  it("formats every text editor command", () => {
    expect(
      formatToolCall({
        input: {
          command: "view",
          path: "src/index.ts",
          view_range: [1, 20],
        },
        summary: "view",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }).text,
    ).toBe('Read(file_path: "src/index.ts", view_range: [1, 20])');
    expect(
      formatToolCall({
        input: {
          command: "create",
          path: "src/new.ts",
        },
        summary: "create",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }).text,
    ).toBe('Create(file_path: "src/new.ts")');
    expect(
      formatToolCall({
        input: {
          command: "insert",
          insert_line: 10,
          path: "src/index.ts",
        },
        summary: "insert",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }).text,
    ).toBe('Edit(file_path: "src/index.ts", insert_line: 10)');
    expect(
      formatToolCall({
        input: {
          command: "str_replace",
          path: "src/index.ts",
        },
        summary: "replace",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }).text,
    ).toBe('Edit(file_path: "src/index.ts")');
  });

  it("formats focused Read, Edit, and Write calls", () => {
    expect(
      formatToolCall({
        input: {
          file_path: "src/index.ts",
          line_end: 20,
          line_start: 5,
        },
        summary: "read",
        title: "Read",
        toolName: "readTool",
        type: "tool_called",
      }).text,
    ).toBe('Read(file_path: "src/index.ts", line_start: 5, line_end: 20)');
    expect(
      formatToolCall({
        input: {
          file_path: "src/index.ts",
          new_string: "next",
          old_string: "current",
          replace_all: true,
        },
        summary: "edit",
        title: "Edit",
        toolName: "editTool",
        type: "tool_called",
      }).text,
    ).toBe('Edit(file_path: "src/index.ts", replace_all: true)');
    expect(
      formatToolCall({
        input: {
          content: "export {};\n",
          file_path: "src/new.ts",
        },
        summary: "write",
        title: "Write",
        toolName: "writeTool",
        type: "tool_called",
      }).text,
    ).toBe('Write(file_path: "src/new.ts")');
  });

  it("summarizes parent subagent tools without repeating their final output", () => {
    expect(
      formatToolCall({
        input: {
          agent_key: "reviewer",
          prompt: "Review the repository",
        },
        summary: "delegate",
        title: "Delegate",
        toolName: "delegateTaskTool",
        type: "tool_called",
      }),
    ).toEqual({
      details: ["Task: Review the repository"],
      text: 'Delegate(agent: "reviewer")',
    });
    expect(
      formatToolCall({
        input: {
          profile_id: "test-runner",
          prompt: "Run focused tests",
        },
        summary: "run agent",
        title: "Agent",
        toolName: "agentRunTool",
        type: "tool_called",
      }),
    ).toEqual({
      details: ["Task: Run focused tests"],
      text: 'Agent(profile: "test-runner")',
    });
    expect(
      formatToolResult(
        {
          output: {
            isError: false,
            llmContent: JSON.stringify({
              finalOutput: "full child output",
              profileId: "test-runner",
              status: "succeeded",
              taskId: "task-1",
            }),
          },
          summary: "agent complete",
          title: "Agent",
          toolName: "agentRunTool",
          type: "tool_output",
        },
        { profile_id: "test-runner" },
      ),
    ).toEqual({
      details: ["Task: task-1"],
      text: "test-runner succeeded",
    });
    expect(
      formatToolResult(
        {
          output: "not-json",
          summary: "delegate complete",
          title: "Delegate",
          toolName: "delegateTaskTool",
          type: "tool_output",
        },
        { agent_key: "reviewer" },
      ),
    ).toEqual({
      text: "reviewer succeeded",
    });
  });

  it("formats TODO call and per-item result", () => {
    const input = {
      items: [
        {
          content: "Inspect implementation",
          status: "pending",
        },
        {
          content: "Run tests",
          status: "in_progress",
        },
        {
          content: "Write documentation",
          status: "completed",
        },
      ],
    };

    expect(
      formatToolCall({
        input,
        summary: "write todo list",
        title: "TodoWrite",
        toolName: "todoWriteTool",
        type: "tool_called",
      }).text,
    ).toBe('Update Todos(items: 3, active: "Run tests")');
    expect(
      formatToolResult(
        {
          output: "1. [ ] Inspect implementation\n2. [-] Run tests\n3. [x] Write documentation",
          summary: "1 pending · 1 in progress · 1 completed",
          title: "TodoWrite",
          toolName: "todoWriteTool",
          type: "tool_output",
        },
        input,
      ),
    ).toEqual({
      detailColors: ["gray", "cyan", "green"],
      details: ["□ Inspect implementation", "□ Run tests", "✓ Write documentation"],
      text: "Status updated: 1 completed, 1 in progress.",
    });
  });

  it("formats Read preview and Edit diff results", () => {
    expect(
      formatToolResult(
        {
          output: "1: first\n2: second",
          summary: "read",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      details: ["second"],
      text: "first",
    });
    expect(
      formatToolResult(
        {
          output: "1: first\n2:   indented\n3: \n4: fourth\n5: fifth\n6: sixth",
          summary: "read",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        {
          command: "view",
        },
      ),
    ).toEqual({
      details: ["  indented", "", "fourth", "... (+2 line(s))"],
      text: "first",
    });
    expect(
      formatToolResult(
        {
          output: "Successfully replaced text.",
          summary: "replace",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        {
          command: "str_replace",
          new_str: "new line",
          old_str: "old line",
        },
      ),
    ).toEqual({
      details: ["- old line", "+ new line"],
      text: "1 addition(s) and 1 deletion(s)",
    });
    expect(
      formatToolResult(
        {
          output: '\n100: import { useState } from "react";\n101: \n102: interface Props {}\n',
          summary: "edit",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      details: ["", "interface Props {}"],
      text: 'import { useState } from "react";',
    });
    expect(
      formatToolResult(
        {
          output: "Successfully replaced text.",
          summary: "replace",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        {
          command: "str_replace",
          new_str: "\nnew 1\nnew 2\nnew 3\nnew 4\n",
          old_str: "\nold 1\nold 2\nold 3\nold 4\n",
        },
      ),
    ).toEqual({
      details: [
        "- old 1",
        "- old 2",
        "- old 3",
        "- old 4",
        "+ new 1",
        "+ new 2",
        "... (+2 line(s))",
      ],
      text: "4 addition(s) and 4 deletion(s)",
    });
  });

  it("prefers structured focused tool previews and diffs", () => {
    expect(
      formatToolResult(
        {
          output: {
            isError: false,
            llmContent: "5: first\n6: second\n7: third\n8: fourth\n9: fifth",
          },
          summary: "read",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        {
          file_path: "src/index.ts",
          line_end: 9,
          line_start: 5,
        },
      ),
    ).toEqual({
      details: ["second", "third", "fourth", "... (+1 line(s))"],
      text: "first",
    });
    expect(
      formatToolResult(
        {
          output: {
            display: {
              filePath: "src/index.ts",
              newText: "new 1\nnew 2",
              oldText: "old 1\nold 2",
              startLine: 10,
              type: "diff",
              writeType: "update",
            },
            isError: false,
            llmContent: "File src/index.ts successfully edited.",
          },
          summary: "edit",
          title: "Edit",
          toolName: "editTool",
          type: "tool_output",
        },
        {
          file_path: "src/index.ts",
          replace_all: false,
        },
      ),
    ).toEqual({
      details: ["- old 1", "- old 2", "+ new 1", "+ new 2"],
      text: "2 addition(s) and 2 deletion(s)",
    });
    expect(
      formatToolResult(
        {
          output: {
            display: {
              filePath: "src/new.ts",
              newText: "created\n",
              oldText: "",
              startLine: 1,
              type: "diff",
              writeType: "add",
            },
            isError: false,
            llmContent: "File src/new.ts successfully written.",
          },
          summary: "write",
          title: "Write",
          toolName: "writeTool",
          type: "tool_output",
        },
        {
          file_path: "src/new.ts",
        },
      ),
    ).toEqual({
      details: ["+ created"],
      text: "1 addition(s) and 0 deletion(s)",
    });
  });

  it("formats structured focused tool errors without mislabeling validation failures", () => {
    const validationResult = formatToolResult(
      {
        output: {
          error: {
            code: "TOOL_INPUT_VALIDATION_ERROR",
            issues: [
              {
                message: "String must contain at least 1 character(s)",
                path: "file_path",
              },
              {
                message: "Required",
                path: "replace_all",
              },
            ],
          },
          isError: true,
          llmContent: "Invalid JSON input for tool: misleading fallback",
        },
        summary: "invalid input",
        title: "Edit",
        toolName: "editTool",
        type: "tool_output",
      },
      {},
    );

    expect(validationResult).toEqual({
      details: ["Invalid tool input at replace_all: Required"],
      text: "Error: Invalid tool input at file_path: String must contain at least 1 character(s)",
    });
    expect(JSON.stringify(validationResult)).not.toContain("Invalid JSON input");
    expect(
      formatToolResult(
        {
          output: {
            error: {
              code: "TOOL_EXECUTION_ERROR",
            },
            isError: true,
            llmContent: "old_string matched more than once",
          },
          summary: "failed",
          title: "Edit",
          toolName: "editTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      text: "Error: old_string matched more than once",
    });
  });

  it("formats empty, error, long, object, circular, and unknown results", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(
      formatToolResult(
        {
          output: undefined,
          summary: "finished",
          title: "Ls",
          toolName: "lsTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      text: "Ls finished",
    });
    expect(
      formatToolResult(
        {
          output: "Error: failed\nreason",
          summary: "failed",
          title: "Bash",
          toolName: "bashTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      details: ["reason"],
      text: "Error: failed",
    });
    expect(
      formatToolResult(
        {
          output: "1\n2\n3\n4\n5\n6\n7\n8",
          summary: "tree",
          title: "Tree",
          toolName: "treeTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      details: ["2", "3", "4", "5", "6", "... (+2 line(s))"],
      text: "1",
    });
    expect(
      formatToolResult(
        {
          output: {
            ok: true,
          },
          summary: "object",
          title: "Tool",
          toolName: "unknownTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      text: '{"ok":true}',
    });
    expect(
      formatToolResult(
        {
          output: circular,
          summary: "circular",
          title: "Tool",
          toolName: "unknownTool",
          type: "tool_output",
        },
        {},
      ),
    ).toEqual({
      text: "[object Object]",
    });
    expect(
      formatToolCall({
        input: undefined,
        summary: "custom action",
        title: "Custom",
        toolName: "customTool",
        type: "tool_called",
      }).text,
    ).toBe('Custom(action: "custom action")');
  });

  it("uses stable fallbacks for missing and invalid tool input", () => {
    expect(
      formatToolCall({
        input: {
          case_sensitive: "invalid",
          include_hidden: 1,
          max_results: Number.NaN,
        },
        summary: "search",
        title: "Grep",
        toolName: "grepTool",
        type: "tool_called",
      }).text,
    ).toBe('Grep(pattern: "unknown", path: ".")');
    expect(
      formatToolCall({
        input: {
          include_hidden: true,
          max_entries: 25,
          path: "src",
        },
        summary: "list",
        title: "Ls",
        toolName: "lsTool",
        type: "tool_called",
      }).text,
    ).toBe('Ls(path: "src", include_hidden: true, max_entries: 25)');
    expect(
      formatToolCall({
        input: {
          include_hidden: false,
          max_depth: "invalid",
          path: "src",
        },
        summary: "tree",
        title: "Tree",
        toolName: "treeTool",
        type: "tool_called",
      }).text,
    ).toBe('Tree(path: "src", include_hidden: false)');
    expect(
      formatToolCall({
        input: {
          command: "unknown",
          path: "",
          view_range: ["invalid"],
        },
        summary: "edit",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }).text,
    ).toBe('Edit(file_path: "unknown", command: "unknown")');
    expect(
      formatToolCall({
        input: undefined,
        summary: "todo",
        title: "TodoWrite",
        toolName: "todoWriteTool",
        type: "tool_called",
      }).text,
    ).toBe("Update Todos(items: 0)");
    expect(
      formatToolCall({
        input: undefined,
        summary: "custom",
        title: "",
        toolName: "customTool",
        type: "tool_called",
      }).text,
    ).toBe('Tool(action: "custom")');
    expect(
      formatToolResult(
        {
          output: "",
          summary: "finished",
          title: "",
          toolName: "customTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      text: "Tool finished",
    });
    expect(
      formatToolResult(
        {
          output: "done",
          summary: "replace",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        {
          command: "str_replace",
        },
      ),
    ).toEqual({
      text: "done",
    });
    expect(
      formatToolResult(
        {
          output: undefined,
          summary: "read",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        {
          command: "view",
        },
      ),
    ).toEqual({
      text: "(empty output)",
    });
    expect(
      formatToolResult(
        {
          output: "100:       disabled={autoRunning}\n101:       <Gauge />",
          summary: "read",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      details: ["      <Gauge />"],
      text: "      disabled={autoRunning}",
    });
  });
});

describe("runtime event presentation", () => {
  it("formats lifecycle events and hides high-volume checkpoints", () => {
    expect(
      formatRuntimeEvent({
        stage: 2,
        stageId: "stage-2",
        totalStages: 2,
        type: "stage_started",
      }),
    ).toEqual({ text: "Stage 2 started (stage-2)" });
    expect(
      formatRuntimeEvent({
        outcome: "paused",
        reason: "needs-review",
        stageId: "stage-2",
        type: "stage_finished",
      }),
    ).toEqual({
      details: ["Reason: needs-review"],
      text: "Stage stage-2 paused",
    });
    expect(
      formatRuntimeEvent({
        blocked: 1,
        completed: 2,
        inProgress: 1,
        pending: 3,
        type: "task_snapshot",
      }),
    ).toEqual({
      text: "Tasks: 2 completed, 1 in progress, 3 pending, 1 blocked",
    });
    expect(
      formatRuntimeEvent({
        checkpointRevision: 9,
        sessionStatus: "active",
        stageId: "stage-2",
        type: "checkpoint_saved",
      }),
    ).toBeUndefined();
    expect(
      formatRuntimeEvent({
        from: "sandbox",
        reason: "sandbox-exec is unavailable",
        to: "host-policy",
        type: "runtime_boundary_changed",
      }),
    ).toEqual({
      details: ["Reason: sandbox-exec is unavailable"],
      text: "Runtime boundary changed: sandbox -> host-policy",
    });
    expect(
      formatRuntimeEvent({
        findings: [
          {
            code: "instruction-override",
            segmentIndex: 0,
            severity: "warning",
            source: "workspace",
            sourceId: "README.md",
            trust: "untrusted",
          },
        ],
        type: "prompt_risk_detected",
      }),
    ).toEqual({
      details: ["instruction-override · workspace:README.md · untrusted"],
      text: "Prompt risk detected: 1 finding(s)",
    });
    expect(
      formatRuntimeEvent({
        durationMs: 25,
        error: "Provider unavailable",
        finishedAt: "2026-08-13T00:00:00.000Z",
        sessionId: "session-1",
        source: "packages/cli/src/app.tsx:100:5",
        type: "session_failed",
      }),
    ).toEqual({
      details: ["Session: session-1", "Source: packages/cli/src/app.tsx:100:5"],
      text: "Error: Provider unavailable",
    });
    expect(
      formatRuntimeEvent({
        attempts: 2,
        counts: {
          error: 0,
          failed: 0,
          "not-run": 0,
          passed: 7,
        },
        decision: "accepted",
        failedChecks: [],
        grade: "A",
        overallScore: 0.92,
        type: "evaluation_finished",
      }),
    ).toEqual({
      details: ["Checks: 7 passed, 0 failed, 0 error, 0 not-run", "Attempts: 2"],
      text: "Evaluation accepted: A (92.0)",
    });
  });

  it("formats optional lifecycle and structured tool branches", () => {
    expect(
      formatRuntimeEvent({
        continuation: "reconstructed-continuation",
        inFlightOperations: 2,
        pendingInputIds: ["question-1"],
        sessionId: "session",
        type: "session_resumed",
      }),
    ).toEqual({
      details: ["In-flight operations: 2", "Continuation: reconstructed-continuation"],
      text: "Session resumed: session",
    });
    expect(
      formatRuntimeEvent({
        outcome: "completed",
        stageId: "stage",
        type: "stage_finished",
      }),
    ).toEqual({ text: "Stage stage completed" });

    for (const [toolName, text] of [
      ["treeTool", 'Tree(path: ".")'],
      ["readTool", 'Read(file_path: "unknown")'],
      ["editTool", 'Edit(file_path: "unknown")'],
      ["writeTool", 'Write(file_path: "unknown")'],
    ] as const) {
      expect(
        formatToolCall({
          summary: "fallback",
          title: "",
          toolName,
          type: "tool_called",
        }).text,
      ).toBe(text);
    }

    expect(
      formatToolResult(
        {
          output: { isError: false, llmContent: "" },
          summary: "empty",
          title: "",
          toolName: "custom",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "Tool finished" });
    expect(
      formatToolResult(
        {
          output: {
            error: {
              code: "TOOL_INPUT_VALIDATION_ERROR",
              issues: [
                { message: "required", path: "" },
                { message: "invalid", path: "file_path" },
                { path: "ignored" },
              ],
            },
            isError: true,
            llmContent: "",
          },
          summary: "invalid",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      details: ["Invalid tool input at file_path: invalid"],
      text: "Error: Invalid tool input: required",
    });
    expect(
      formatToolResult(
        {
          output: {
            error: { code: "TOOL_INPUT_VALIDATION_ERROR", issues: "invalid" },
            isError: true,
            llmContent: "",
          },
          summary: "invalid",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "Error: Invalid tool input" });
    expect(
      formatToolResult(
        {
          output: { error: { code: "TOOL_EXECUTION_ERROR" }, isError: true, llmContent: "" },
          summary: "failed",
          title: "",
          toolName: "custom",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "Error: Tool failed" });
    expect(
      formatToolResult(
        {
          output: {
            display: { newText: "", oldText: "", type: "diff" },
            isError: false,
            llmContent: "edited",
          },
          summary: "edited",
          title: "Edit",
          toolName: "editTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "0 addition(s) and 0 deletion(s)" });
    expect(
      formatToolResult(
        {
          output: { isError: false, llmContent: "one\ntwo\nthree\nfour" },
          summary: "bash",
          title: "Bash",
          toolName: "bashTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({
      details: ["two", "three", "... (+1 line(s))"],
      text: "one",
    });
    expect(
      formatToolResult(
        {
          output: {
            error: {
              code: "TOOL_INPUT_VALIDATION_ERROR",
              issues: [{ message: "required", path: 1 }],
            },
            isError: true,
            llmContent: "",
          },
          summary: "invalid",
          title: "Read",
          toolName: "readTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "Error: Invalid tool input: required" });
    expect(
      formatToolResult(
        {
          output: {
            error: { code: "TOOL_EXECUTION_ERROR" },
            isError: true,
            llmContent: "Error: direct",
          },
          summary: "failed",
          title: "Tool",
          toolName: "custom",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "Error: direct" });
    expect(
      formatToolResult(
        {
          output: "done",
          summary: "inserted",
          title: "Edit",
          toolName: "textEditorTool",
          type: "tool_output",
        },
        { command: "insert" },
      ),
    ).toEqual({ text: "done" });
    expect(
      formatToolResult(
        {
          output: { invalid: true },
          summary: "todo fallback",
          title: "Todo",
          toolName: "todoWriteTool",
          type: "tool_output",
        },
        undefined,
      ),
    ).toEqual({ text: "todo fallback" });
    expect(
      formatToolCall({
        input: { command: "view", path: "file", view_range: ["bad"] },
        summary: "view",
        title: "Edit",
        toolName: "textEditorTool",
        type: "tool_called",
      }),
    ).toEqual({ text: 'Read(file_path: "file")' });
  });
});
