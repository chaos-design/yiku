import { describe, expect, it } from "vitest";
import {
  formatToolTraceLabel,
  getToolOutputTraceDetails,
  getToolTraceDetails,
} from "../../../src/tools/common/trace.js";

describe("tool trace helpers", () => {
  it("summarizes built-in tool inputs", () => {
    expect(getToolTraceDetails("AskUserQuestion", { question: "Which database?" })).toEqual({
      summary: "ask Which database?",
      title: "AskUser",
    });
    expect(getToolTraceDetails("askUserTool", { question: "Legacy question?" }).summary).toBe(
      "ask Legacy question?",
    );
    expect(
      getToolTraceDetails("AskUserQuestion", {
        questions: [{ header: "风格", question: "选择标题风格。" }],
      }).summary,
    ).toBe("ask 选择标题风格。");
    expect(getToolTraceDetails("AskUserQuestion").summary).toBe("ask user");
    expect(getToolTraceDetails("AskUserQuestion", { questions: [] }).summary).toBe("ask user");
    expect(
      getToolTraceDetails("AskUserQuestion", {
        question: "x".repeat(220),
      }).summary.endsWith("…"),
    ).toBe(true);
    expect(getToolTraceDetails("bashTool")).toEqual({
      summary: "run bash command",
      title: "Bash",
    });
    expect(getToolTraceDetails("bashTool", { restart: true }).summary).toBe("restart bash session");
    expect(getToolTraceDetails("bashTool", { command: "pnpm   test" }).summary).toBe(
      "run pnpm test",
    );
    expect(getToolTraceDetails("grepTool", { pattern: "Agent", path: "packages" }).summary).toBe(
      "search Agent in packages",
    );
    expect(getToolTraceDetails("grepTool", { pattern: "Agent" }).summary).toBe("search Agent");
    expect(getToolTraceDetails("grepTool", {}).summary).toBe("search files");
    expect(getToolTraceDetails("lsTool", {}).summary).toBe("list .");
    expect(
      getToolTraceDetails("textEditorTool", { command: "view", path: "README.md" }).summary,
    ).toBe("view README.md");
    expect(getToolTraceDetails("textEditorTool", { command: "view" }).summary).toBe("view");
    expect(getToolTraceDetails("textEditorTool", {}).summary).toBe("edit file");
    expect(getToolTraceDetails("todoWriteTool", {}).summary).toBe("write todo list");
    expect(
      getToolTraceDetails("todoWriteTool", {
        items: [{ content: "Run tests", status: "in_progress" }],
      }).summary,
    ).toBe("write 1 item; active Run tests");
    expect(
      getToolTraceDetails("todoWriteTool", {
        items: [
          { content: "Inspect", status: "pending" },
          { content: "Run tests", status: "completed" },
        ],
      }).summary,
    ).toBe("write 2 items");
    expect(getToolTraceDetails("treeTool", { path: "src" }).summary).toBe("render tree src");
    expect(getToolTraceDetails("treeTool", { max_depth: 2 }).summary).toBe("render tree . depth 2");
    expect(getToolTraceDetails("unknownTool").summary).toBe("execute tool");
  });

  it("summarizes tool outputs", () => {
    expect(getToolOutputTraceDetails("bashTool", "passed")).toEqual({
      summary: "finished passed",
      title: "Bash",
    });
    expect(getToolOutputTraceDetails("bashTool").summary).toBe("Bash finished");
    expect(getToolOutputTraceDetails("unknownTool", { ok: true })).toEqual({
      summary: 'finished {"ok":true}',
      title: "Tool",
    });
    expect(getToolOutputTraceDetails("todoWriteTool", "TODO list is empty.").summary).toBe(
      "0 pending · 0 in progress · 0 completed",
    );
    expect(
      getToolOutputTraceDetails(
        "todoWriteTool",
        "1. [ ] Inspect\n2. [-] Run tests\n3. [x] Write docs",
      ).summary,
    ).toBe("1 pending · 1 in progress · 1 completed · active: Run tests");
    expect(
      getToolOutputTraceDetails("todoWriteTool", "1. [ ] Inspect\n2. [x] Write docs").summary,
    ).toBe("1 pending · 0 in progress · 1 completed");
    expect(getToolOutputTraceDetails("todoWriteTool", { ok: true }).summary).toBe(
      'finished {"ok":true}',
    );
    expect(getToolOutputTraceDetails("todoWriteTool", "not a todo").summary).toBe(
      "finished not a todo",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(getToolOutputTraceDetails("unknownTool", circular).summary).toBe(
      "finished [object Object]",
    );
  });

  it("formats trace labels", () => {
    expect(formatToolTraceLabel({ summary: "run pnpm test", title: "Bash" })).toBe(
      "Bash: run pnpm test",
    );
  });
});
