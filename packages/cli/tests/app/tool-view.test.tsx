import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  getDetailLineColor,
  getResultColor,
  getToolCallColor,
  ToolBlockView,
} from "../../src/app/tool-view.js";

describe("ToolBlockView", () => {
  it("renders TODO items before the status summary", () => {
    const app = render(
      <ToolBlockView
        item={{
          call: {
            text: "Update Todos(items: 3)",
          },
          id: "tool:todo",
          kind: "tool",
          result: {
            detailColors: ["gray", "cyan", "green"],
            details: ["□ Inspect implementation", "□ Run tests", "✓ Write documentation"],
            text: "Status updated: 1 completed, 1 in progress.",
          },
          toolName: "todoWriteTool",
        }}
      />,
    );
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("● Update Todos(items: 3)");
    expect(frame).toContain("├□ Inspect implementation");
    expect(frame).toContain("├□ Run tests");
    expect(frame).toContain("└✓ Write documentation");
    expect(frame).toContain("└ Status updated: 1 completed, 1 in progress.");
    expect(frame.indexOf("Run tests")).toBeLessThan(frame.indexOf("Status updated"));

    app.unmount();
  });

  it("adds an ellipsis while TODO is active", () => {
    const app = render(
      <ToolBlockView
        item={{
          call: {
            text: "Update Todos(items: 1)",
          },
          id: "tool:active-todo",
          kind: "tool",
          toolName: "todoWriteTool",
        }}
      />,
    );

    expect(app.lastFrame()).toContain("● Update Todos(items: 1)…");

    app.unmount();
  });

  it("renders Bash and Read output under the call", () => {
    const app = render(
      <ToolBlockView
        item={{
          call: {
            details: ["Task: Run the focused test suite"],
            text: "Bash(pnpm test)",
          },
          id: "tool:bash",
          kind: "tool",
          result: {
            details: ["line 2", "... (+2 line(s))"],
            text: "line 1",
          },
          toolName: "bashTool",
        }}
      />,
    );

    expect(app.lastFrame()).toContain("● Bash(pnpm test)");
    expect(app.lastFrame()).toContain("Task: Run the focused test suite");
    expect(app.lastFrame()).toContain("└ line 1");
    expect(app.lastFrame()).toContain("... (+2 line(s))");

    app.rerender(
      <ToolBlockView
        item={{
          call: {
            text: 'Read(file_path: "package.json")',
          },
          id: "tool:read",
          kind: "tool",
          result: {
            details: ['"name": "yiku"', "... (+30 line(s))"],
            text: "{",
          },
          toolName: "textEditorTool",
        }}
      />,
    );

    expect(app.lastFrame()).toContain('● Read(file_path: "package.json")');
    expect(app.lastFrame()).toContain("└ {");
    expect(app.lastFrame()).toContain("... (+30 line(s))");

    app.unmount();
  });

  it("uses reference colors while preserving semantic result colors", () => {
    expect(getToolCallColor("todoWriteTool")).toBe("magenta");
    expect(getToolCallColor("bashTool")).toBe("green");
    expect(getResultColor("command output")).toBe("white");
    expect(getResultColor("Error: command failed")).toBe("red");
    expect(getDetailLineColor("continued output")).toBe("white");
    expect(getDetailLineColor("... (+42 line(s))")).toBe("gray");
    expect(getDetailLineColor("+ added line")).toBe("green");
    expect(getDetailLineColor("- removed line")).toBe("red");
    expect(getDetailLineColor("✓ completed item")).toBe("green");
    expect(getDetailLineColor("● active item")).toBe("yellow");
  });

  it("renders compact summaries and verbose raw outputs", () => {
    const app = render(
      <ToolBlockView
        item={{
          call: { text: "Bash(test)" },
          id: "compact-lines",
          kind: "tool",
          output: "line 1\nline 2",
          result: { text: "line 1" },
          toolName: "bashTool",
        }}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("Bash(test) → 2 lines");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Bash(test)" },
          id: "compact-one",
          kind: "tool",
          output: "done",
          result: { text: "done" },
          toolName: "bashTool",
        }}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("→ done");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Read(file)" },
          id: "verbose-structured",
          kind: "tool",
          output: { isError: false, llmContent: "\n1: first\n2: second\n" },
          result: { text: "first" },
          toolName: "readTool",
        }}
        outputStyle="verbose"
      />,
    );
    expect(app.lastFrame()).toContain("first");
    expect(app.lastFrame()).toContain("second");
    expect(app.lastFrame()).not.toContain("1: first");
    expect(app.lastFrame()).not.toContain("2: second");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool()" },
          id: "verbose-object",
          kind: "tool",
          output: { ok: true },
          result: { text: "fallback" },
          toolName: "custom",
        }}
        outputStyle="verbose"
      />,
    );
    expect(app.lastFrame()).toContain('"ok": true');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool()" },
          id: "compact-circular",
          kind: "tool",
          output: circular,
          result: { text: "fallback" },
          toolName: "custom",
        }}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("[object Object]");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool()" },
          id: "compact-fallback",
          kind: "tool",
          result: { text: "fallback" },
          toolName: "custom",
        }}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("→ fallback");
    app.unmount();
  });

  it("renders missing, blank, primitive, and prefixed tool output branches", () => {
    const app = render(
      <ToolBlockView
        item={{
          call: { text: "Tool" },
          id: "compact-pending",
          kind: "tool",
          toolName: "custom",
        }}
        outputStyle="compact"
        prefix="├ "
      />,
    );
    expect(app.lastFrame()).toContain("├ ● Tool");
    expect(app.lastFrame()).not.toContain("→");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool()" },
          id: "compact-blank",
          kind: "tool",
          output: "\n",
          result: { text: "blank fallback" },
          toolName: "custom",
        }}
        outputStyle="compact"
      />,
    );
    expect(app.lastFrame()).toContain("→ blank fallback");

    for (const [id, output, expected] of [
      ["number", 42, "42"],
      ["null", null, "null"],
    ] as const) {
      app.rerender(
        <ToolBlockView
          item={{
            call: { text: "Tool()" },
            id,
            kind: "tool",
            output,
            result: { text: "fallback" },
            toolName: "custom",
          }}
          outputStyle="compact"
        />,
      );
      expect(app.lastFrame()).toContain(`→ ${expected}`);
    }

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool()" },
          id: "verbose-blank",
          kind: "tool",
          output: " ",
          result: { text: "verbose fallback" },
          toolName: "custom",
        }}
        outputStyle="verbose"
      />,
    );
    expect(app.lastFrame()).toContain("verbose fallback");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Tool" },
          id: "verbose-one-line",
          kind: "tool",
          output: "one line",
          result: { text: "fallback" },
          toolName: "custom",
        }}
        outputStyle="verbose"
      />,
    );
    expect(app.lastFrame()).toContain("● Tool");
    expect(app.lastFrame()).toContain("one line");

    app.rerender(
      <ToolBlockView
        item={{
          call: { text: "Todo(items: 1)" },
          id: "todo-default-colors",
          kind: "tool",
          result: { details: ["● active"], text: "pending" },
          toolName: "todoWriteTool",
        }}
      />,
    );
    expect(app.lastFrame()).toContain("└● active");
    app.unmount();
  });
});
