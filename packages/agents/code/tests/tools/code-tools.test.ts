import { describe, expect, it, vi } from "vitest";
import { textEditorTool as publicTextEditorTool } from "../../src/index.js";
import { CodeToolset } from "../../src/tools/code-tools.js";
import { textEditorTool as toolsTextEditorTool } from "../../src/tools/index.js";

describe("CodeToolset", () => {
  it("exposes the complete read-write toolset", () => {
    const toolset = new CodeToolset();

    try {
      expect(toolset.tools.map((tool) => tool.name)).toEqual([
        "bashTool",
        "grepTool",
        "lsTool",
        "readTool",
        "editTool",
        "writeTool",
        "todoWriteTool",
        "treeTool",
        "askUserTool",
      ]);
      expect(Object.isFrozen(toolset.tools)).toBe(true);
      expect(toolset.tools.some((tool) => tool.name === "textEditorTool")).toBe(false);
      expect(publicTextEditorTool).toBe(toolsTextEditorTool);
    } finally {
      toolset.close();
    }
  });

  it("keeps a stable toolset in read-only mode so writes can request an upgrade", () => {
    const toolset = new CodeToolset({ accessMode: "read-only" });

    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      "bashTool",
      "grepTool",
      "lsTool",
      "readTool",
      "editTool",
      "writeTool",
      "todoWriteTool",
      "treeTool",
      "askUserTool",
    ]);
    toolset.close();
    toolset.close();
  });

  it("uses an injected TODO executor", async () => {
    const write = vi.fn(async () => "persisted");
    const toolset = new CodeToolset({
      todoExecutor: { write },
    });
    const todoTool = toolset.tools.find((tool) => tool.name === "todoWriteTool");

    try {
      await expect(
        todoTool?.invoke(
          {} as never,
          JSON.stringify({ items: [{ content: "test", status: "in_progress" }] }),
        ),
      ).resolves.toBe("persisted");
      expect(write).toHaveBeenCalledOnce();
    } finally {
      toolset.close();
    }
  });
});
